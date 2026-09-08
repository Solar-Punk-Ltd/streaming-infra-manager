import http from 'node:http';
import { createConnection, type Socket } from 'node:net';
import type { BeeTransaction, ChequebookBalance } from '@streaming-infra-manager/common';
import type { BeeAddresses, BeeChequebookAddress, BeeWallet } from '../BeeClient.js';
import { BeeConnectionError } from '../errors/BeeConnectionError.js';

export interface BeeTransferSession {
  getAddresses(): Promise<BeeAddresses>;
  getWallet(): Promise<BeeWallet>;
  getChequebookAddress(): Promise<BeeChequebookAddress>;
  getChequebookBalance(): Promise<ChequebookBalance>;
  depositChequebook(amountPlur: bigint): Promise<BeeTransaction>;
  withdrawChequebook(amountPlur: bigint): Promise<BeeTransaction>;
  assertUsable(): void;
  dispose(): void;
}

class OneConnectionAgent extends http.Agent {
  #opened = false;
  #socket: Socket | undefined;
  #closed = false;

  constructor(private readonly hostname: string, private readonly port: number, private readonly unavailable: () => void) {
    super({ keepAlive: true, maxSockets: 1, maxTotalSockets: 1, maxFreeSockets: 1 });
  }

  // Node's Agent calls this hook for every attempted connection, including replacement sockets.
  createConnection(_options: http.ClientRequestArgs, callback: (error: Error | null, socket?: Socket) => void): Socket | undefined {
    if (this.#opened || this.#closed) { queueMicrotask(() => callback(new BeeConnectionError())); return; }
    this.#opened = true;
    const socket = createConnection({ host: this.hostname, port: this.port });
    this.#socket = socket;
    socket.on('close', this.unavailable);
    socket.on('end', this.unavailable);
    socket.on('error', this.unavailable);
    return socket;
  }

  accepts(socket: Socket): boolean { return socket === this.#socket && !this.#closed; }
  isConnected(): boolean { return this.#opened && !this.#closed && !!this.#socket && !this.#socket.destroyed && !this.#socket.readableEnded; }
  override destroy(): void { this.#closed = true; super.destroy(); }
}

/** Only for a direct Bee listener or connection-preserving Docker port mapping, never a routing proxy. */
export class PinnedBeeSession implements BeeTransferSession {
  #target: URL;
  #agent: OneConnectionAgent;
  #unusable = false;
  #busy = false;
  #posted = false;
  #readTimeoutMs: number;
  #postTimeoutMs: number;
  #maxResponseBytes: number;
  #preflightTimer: ReturnType<typeof setTimeout>;

  constructor(baseUrl: string, options: { readTimeoutMs?: number; postTimeoutMs?: number; preflightTimeoutMs?: number; maxResponseBytes?: number } = {}) {
    try {
      this.#target = new URL(baseUrl);
      if (this.#target.protocol !== 'http:' || this.#target.username || this.#target.password || this.#target.pathname !== '/' || this.#target.search || this.#target.hash) throw new BeeConnectionError();
    } catch { throw new BeeConnectionError(); }
    this.#readTimeoutMs = options.readTimeoutMs ?? 10_000;
    this.#postTimeoutMs = options.postTimeoutMs ?? 180_000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 64 * 1024;
    const preflightTimeoutMs = options.preflightTimeoutMs ?? 30_000;
    for (const [value, maximum] of [[this.#readTimeoutMs, 30_000], [this.#postTimeoutMs, 180_000], [preflightTimeoutMs, 60_000], [this.#maxResponseBytes, 1024 * 1024]]) {
      if (!Number.isInteger(value) || value! < 1 || value! > maximum!) throw new BeeConnectionError();
    }
    this.#agent = new OneConnectionAgent(this.#target.hostname.replace(/^\[|\]$/g, ''), Number(this.#target.port || 80), () => { this.#unusable = true; });
    this.#preflightTimer = setTimeout(() => this.dispose(), preflightTimeoutMs);
  }

  getAddresses(): Promise<BeeAddresses> { return this.#request('GET', '/addresses', this.#readTimeoutMs); }
  getWallet(): Promise<BeeWallet> { return this.#request('GET', '/wallet', this.#readTimeoutMs); }
  getChequebookAddress(): Promise<BeeChequebookAddress> { return this.#request('GET', '/chequebook/address', this.#readTimeoutMs); }
  getChequebookBalance(): Promise<ChequebookBalance> { return this.#request('GET', '/chequebook/balance', this.#readTimeoutMs); }
  getPendingTransactions(): Promise<unknown> { return this.#request('GET', '/transactions', this.#readTimeoutMs); }
  depositChequebook(amountPlur: bigint): Promise<BeeTransaction> { return this.#send('deposit', amountPlur); }
  withdrawChequebook(amountPlur: bigint): Promise<BeeTransaction> { return this.#send('withdraw', amountPlur); }

  assertUsable(): void {
    if (this.#unusable || !this.#agent.isConnected()) throw new BeeConnectionError();
  }

  dispose(): void {
    this.#unusable = true;
    clearTimeout(this.#preflightTimer);
    this.#agent.destroy();
  }

  async #send(direction: 'deposit' | 'withdraw', amount: bigint): Promise<BeeTransaction> {
    if (typeof amount !== 'bigint' || amount < 1n || amount.toString().length > 30 || this.#posted || this.#busy) throw new BeeConnectionError();
    this.assertUsable();
    this.#posted = true;
    clearTimeout(this.#preflightTimer);
    return this.#request('POST', `/chequebook/${direction}?amount=${amount}`, this.#postTimeoutMs);
  }

  async #request<T>(method: 'GET' | 'POST', path: string, timeoutMs: number): Promise<T> {
    if (this.#unusable || this.#busy || (method === 'GET' && this.#posted)) throw new BeeConnectionError();
    this.#busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        const request = http.request(this.#target, { method, path, agent: this.#agent, maxHeaderSize: 16 * 1024 }, response => {
          const closes = response.headers.connection?.split(',').some(value => value.trim().toLowerCase() === 'close');
          if (closes) this.#unusable = true;
          if ((closes && method === 'GET') || response.statusCode !== 200 || Number(response.headers['content-length']) > this.#maxResponseBytes) {
            response.destroy(); reject(new BeeConnectionError()); return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > this.#maxResponseBytes) { response.destroy(new BeeConnectionError()); return; }
            chunks.push(chunk);
          });
          response.on('error', () => reject(new BeeConnectionError()));
          response.on('end', () => {
            try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))) as T); }
            catch { reject(new BeeConnectionError()); }
          });
        });
        request.on('socket', socket => {
          if (!this.#agent.accepts(socket)) request.destroy(new BeeConnectionError());
        });
        request.on('error', () => reject(new BeeConnectionError()));
        timer = setTimeout(() => request.destroy(new BeeConnectionError()), timeoutMs);
        request.end();
      });
    } catch {
      this.dispose();
      throw new BeeConnectionError();
    } finally {
      clearTimeout(timer);
      this.#busy = false;
    }
  }
}
