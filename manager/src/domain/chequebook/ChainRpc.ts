import { ChainEvidenceError } from '../errors/ChainEvidenceError.js';
import { ChainReadError } from '../errors/ChainReadError.js';
import { chainAddress, chainHash, chainIdFromQuantity, chainObject, chainQuantity, parseChainReceipt, parseChainTransaction, type ChainReceipt, type ChainTransaction } from './chainEvidence.js';

export interface ChainBlockHeader {
  readonly number: string;
  readonly hash: string;
  readonly parentHash: string;
}

export interface ChainBlock extends ChainBlockHeader {
  readonly transactions: readonly ChainTransaction[];
}

interface ChainRpcOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

type ReadMethod = 'eth_chainId' | 'eth_getTransactionCount' | 'eth_getTransactionByHash' | 'eth_getTransactionReceipt' | 'eth_getBlockByNumber' | 'eth_getBlockTransactionCountByHash';

function blockTag(block: bigint | 'latest'): string {
  if (block === 'latest') return block;
  const tag = `0x${block.toString(16)}`;
  chainQuantity(tag);
  return tag;
}

function blockHeader(value: unknown, expected: bigint | 'latest'): ChainBlockHeader {
  const block = chainObject(value);
  const number = chainQuantity(block.number).toString();
  if (expected !== 'latest' && number !== expected.toString()) throw new ChainEvidenceError();
  return Object.freeze({ number, hash: chainHash(block.hash), parentHash: chainHash(block.parentHash) });
}

/** Bounded observations only. The endpoint and upstream diagnostics never enter returned errors. */
export class ChainRpc {
  #endpoint: string;
  #timeoutMs: number;
  #maxResponseBytes: number;
  #nextId = 1;

  constructor(endpoint: string, options: ChainRpcOptions = {}) {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ChainReadError();
    } catch {
      throw new ChainReadError();
    }
    this.#endpoint = endpoint;
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 60_000 ||
        !Number.isInteger(this.#maxResponseBytes) || this.#maxResponseBytes < 1 || this.#maxResponseBytes > 16 * 1024 * 1024) throw new ChainReadError();
  }

  async chainId(signal?: AbortSignal): Promise<number> {
    return chainIdFromQuantity(await this.#call('eth_chainId', [], signal));
  }

  async transactionCount(address: string, block: bigint, signal?: AbortSignal): Promise<string> {
    return chainQuantity(await this.#call('eth_getTransactionCount', [chainAddress(address), blockTag(block)], signal)).toString();
  }

  async transaction(hash: string, signal?: AbortSignal): Promise<ChainTransaction | null> {
    const expected = chainHash(hash);
    const value = await this.#call('eth_getTransactionByHash', [expected], signal);
    if (value === null) return null;
    const transaction = parseChainTransaction(value);
    if (transaction.hash !== expected) throw new ChainEvidenceError();
    return transaction;
  }

  async receipt(hash: string, signal?: AbortSignal): Promise<ChainReceipt | null> {
    const expected = chainHash(hash);
    const receipt = parseChainReceipt(await this.#call('eth_getTransactionReceipt', [expected], signal));
    if (receipt && receipt.transactionHash !== expected) throw new ChainEvidenceError();
    return receipt;
  }

  async blockHeader(block: bigint | 'latest', signal?: AbortSignal): Promise<ChainBlockHeader | null> {
    const value = await this.#call('eth_getBlockByNumber', [blockTag(block), false], signal);
    return value === null ? null : blockHeader(value, block);
  }

  async blockTransactions(block: bigint, nodeAddress: string, signal?: AbortSignal): Promise<ChainBlock | null> {
    const sender = chainAddress(nodeAddress);
    const value = await this.#call('eth_getBlockByNumber', [blockTag(block), true], signal);
    if (value === null) return null;
    const header = blockHeader(value, block);
    const rawTransactions = chainObject(value).transactions;
    if (!Array.isArray(rawTransactions)) throw new ChainEvidenceError();
    const transactions: ChainTransaction[] = [];
    const seenHashes = new Set<string>();
    for (const [index, value] of rawTransactions.entries()) {
      const transaction = chainObject(value);
      const hash = chainHash(transaction.hash);
      if (seenHashes.has(hash) || chainQuantity(transaction.transactionIndex) !== BigInt(index)) throw new ChainEvidenceError();
      seenHashes.add(hash);
      if (chainHash(transaction.blockHash) !== header.hash || chainQuantity(transaction.blockNumber).toString() !== header.number) throw new ChainEvidenceError();
      if (chainAddress(transaction.from) === sender) transactions.push(parseChainTransaction(value));
    }
    const count = chainQuantity(await this.#call('eth_getBlockTransactionCountByHash', [header.hash], signal));
    if (count !== BigInt(rawTransactions.length)) throw new ChainEvidenceError();
    return Object.freeze({ ...header, transactions: Object.freeze(transactions) });
  }

  async #call(method: ReadMethod, params: unknown[], callerSignal?: AbortSignal): Promise<unknown> {
    const cleanup = new AbortController();
    const signal = AbortSignal.any([cleanup.signal, AbortSignal.timeout(this.#timeoutMs), ...(callerSignal ? [callerSignal] : [])]);
    const id = this.#nextId++;
    try {
      signal.throwIfAborted();
      const response = await fetch(this.#endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        redirect: 'error',
        signal,
      });
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > this.#maxResponseBytes) throw new ChainReadError();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > this.#maxResponseBytes) throw new ChainReadError();
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      signal.throwIfAborted();
      const body = chainObject(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))));
      if (body.jsonrpc !== '2.0' || body.id !== id || Object.hasOwn(body, 'error') || !Object.hasOwn(body, 'result')) throw new ChainReadError();
      return body.result;
    } catch {
      throw new ChainReadError();
    } finally {
      cleanup.abort();
    }
  }
}
