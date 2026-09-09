import http from 'node:http';
import { performance } from 'node:perf_hooks';
import type { Duplex } from 'node:stream';
import { DockerBeeAcquisitionError } from '../errors/DockerBeeAcquisitionError.js';
import type { FrozenChequebookTarget } from './FrozenChequebookTarget.js';
import { OwnedHttpStream } from './OwnedHttpStream.js';
import { createDockerExecDuplex } from './createDockerExecDuplex.js';
import { dockerObject, fullDockerId, listedBeeContainer, observedBeeContainer, type ObservedBeeContainer } from './DockerBeeBinding.js';
import { dockerBeeBridgeCommand } from './dockerBeeBridge.js';

export interface DockerBeeAcquisitionOptions {
  acquisitionTimeoutMs?: number;
  preflightTimeoutMs?: number;
  postTimeoutMs?: number;
  cleanupGraceMs?: number;
}
export interface AcquiredDockerBeeStream {
  readonly stream: Duplex;
  readonly binding: ObservedBeeContainer;
}
/** Trusted qualification of the exact immutable image, never a request field or an operator assertion. */
export type QualifiedBeeBridgeImage = (imageId: string) => boolean;
type Budgets = Required<DockerBeeAcquisitionOptions>;
const MAX_JSON_BYTES = 1024 * 1024;
const ignoreLateError = () => {};

function budgets(input: DockerBeeAcquisitionOptions): Budgets {
  if (!input || typeof input !== 'object') throw new DockerBeeAcquisitionError();
  const value = { acquisitionTimeoutMs: input.acquisitionTimeoutMs ?? 15_000, preflightTimeoutMs: input.preflightTimeoutMs ?? 30_000,
    postTimeoutMs: input.postTimeoutMs ?? 180_000, cleanupGraceMs: input.cleanupGraceMs ?? 5000 };
  for (const [amount, maximum] of [[value.acquisitionTimeoutMs, 30_000], [value.preflightTimeoutMs, 60_000], [value.postTimeoutMs, 180_000], [value.cleanupGraceMs, 10_000]]) {
    if (!Number.isSafeInteger(amount) || amount! < 1 || amount! > maximum!) throw new DockerBeeAcquisitionError();
  }
  return value;
}

function requireTarget(target: FrozenChequebookTarget): void {
  if (target?.version !== 1 || typeof target.daemonId !== 'string' || !target.daemonId.trim() || target.daemonId.length > 200 ||
      typeof target.profile?.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(target.profile.name) ||
      target.reservation?.service !== 'bee-uploader' || target.reservation.portVar !== 'BEE_UPLOADER_API_PORT' || target.reservation.protocol !== 'tcp' ||
      !Number.isSafeInteger(target.reservation.port) || target.reservation.port < 1 || target.reservation.port > 65535) throw new DockerBeeAcquisitionError();
}

class DockerHandshake extends http.Agent {
  #assigned = false;
  #released = false;
  #closed = false;
  #upgraded = false;
  readonly #timer: NodeJS.Timeout;

  constructor(readonly stream: OwnedHttpStream, private readonly deadline: number, private readonly signal?: AbortSignal) {
    super({ keepAlive: true, maxSockets: 1, maxTotalSockets: 1, maxFreeSockets: 1 });
    stream.on('error', this.onFailure);
    stream.on('end', this.onFailure);
    stream.on('close', this.onFailure);
    signal?.addEventListener('abort', this.onFailure, { once: true });
    this.#timer = setTimeout(this.onFailure, Math.max(1, deadline - performance.now()));
  }

  createConnection(_options: http.ClientRequestArgs, callback: (error: Error | null, socket?: Duplex) => void): Duplex | undefined {
    if (this.#assigned || this.#closed || this.stream.destroyed) { queueMicrotask(() => callback(new DockerBeeAcquisitionError())); return; }
    this.#assigned = true;
    return this.stream;
  }

  requireActive(): void {
    if (this.#closed || this.stream.destroyed || this.signal?.aborted || performance.now() >= this.deadline) throw new DockerBeeAcquisitionError();
  }

  async json(method: 'GET' | 'POST', path: string, status: number, body?: unknown): Promise<unknown> {
    this.requireActive();
    return new Promise((resolve, reject) => {
      const request = this.request(method, path, body);
      request.on('error', () => reject(new DockerBeeAcquisitionError()));
      request.on('upgrade', (_response, socket) => { socket.destroy(); reject(new DockerBeeAcquisitionError()); });
      request.on('response', response => {
        if (response.statusCode !== status || response.headers.connection?.split(',').some(value => value.trim().toLowerCase() === 'close') ||
            (response.headers['content-length'] !== undefined && (!/^[0-9]+$/.test(response.headers['content-length']) || Number(response.headers['content-length']) > MAX_JSON_BYTES))) {
          response.destroy(); reject(new DockerBeeAcquisitionError()); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        response.on('error', () => reject(new DockerBeeAcquisitionError()));
        response.on('aborted', () => reject(new DockerBeeAcquisitionError()));
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_JSON_BYTES) { response.destroy(new DockerBeeAcquisitionError()); return; }
          chunks.push(chunk);
        });
        response.on('end', () => {
          try { this.requireActive(); resolve(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks, size)))); }
          catch { reject(new DockerBeeAcquisitionError()); }
        });
      });
    });
  }

  async upgrade(execId: string): Promise<void> {
    this.requireActive();
    await new Promise<void>((resolve, reject) => {
      const request = this.request('POST', `/exec/${execId}/start`, { Detach: false, Tty: false }, true);
      request.on('error', () => reject(new DockerBeeAcquisitionError()));
      request.on('response', response => { response.destroy(); reject(new DockerBeeAcquisitionError()); });
      request.on('upgrade', (response, socket, head) => {
        try {
          this.requireActive();
          if (response.statusCode !== 101 || !this.accepts(socket) || response.headers.upgrade?.toLowerCase() !== 'tcp' ||
              !response.headers.connection?.split(',').some(value => value.trim().toLowerCase() === 'upgrade')) throw new DockerBeeAcquisitionError();
          this.stream.pause();
          if (head.length) this.stream.unshift(head);
          this.#upgraded = true;
          resolve();
        } catch { socket.destroy(); reject(new DockerBeeAcquisitionError()); }
      });
    });
  }

  release(): void {
    this.requireActive();
    // Node emits agentRemove before the native upgrade event. Do not transfer a pooled stream.
    if (!this.#upgraded || Object.values(this.sockets).some(sockets => sockets?.some(socket => this.accepts(socket))) ||
        Object.values(this.freeSockets).some(sockets => sockets?.some(socket => this.accepts(socket)))) throw new DockerBeeAcquisitionError();
    this.#released = true;
    this.destroy();
  }

  override destroy(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timer);
    this.signal?.removeEventListener('abort', this.onFailure);
    this.stream.removeListener('error', this.onFailure);
    this.stream.removeListener('end', this.onFailure);
    this.stream.removeListener('close', this.onFailure);
    if (!this.#released && !this.stream.destroyed) this.stream.destroy();
    super.destroy();
  }

  private readonly onFailure = () => this.destroy();
  private accepts(stream: Duplex): boolean { return stream === this.stream; }

  private request(method: 'GET' | 'POST', path: string, body?: unknown, upgrade = false): http.ClientRequest {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request('http://docker.invalid/', { method, path, agent: this, maxHeaderSize: 16 * 1024,
      headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
        ...(upgrade ? { Connection: 'Upgrade', Upgrade: 'tcp' } : {}) } });
    request.on('socket', socket => { if (!this.accepts(socket)) request.destroy(new DockerBeeAcquisitionError()); });
    request.on('information', () => request.destroy(new DockerBeeAcquisitionError()));
    request.end(data);
    return request;
  }
}

/** Owns one supplied Docker API connection. No connector, retry or production caller is installed here. */
export async function acquireDockerBeeStream(transport: Duplex, expected: FrozenChequebookTarget, options: DockerBeeAcquisitionOptions = {},
  qualifyImage: QualifiedBeeBridgeImage = () => false, signal?: AbortSignal): Promise<AcquiredDockerBeeStream> {
  let owned: OwnedHttpStream | undefined;
  let handshake: DockerHandshake | undefined;
  let stream: Duplex | undefined;
  try {
    owned = new OwnedHttpStream(transport);
    owned.on('error', ignoreLateError);
    const target = structuredClone(expected);
    const limits = budgets(structuredClone(options));
    requireTarget(target);
    const startedAt = performance.now();
    const bridgeLifetimeMs = limits.acquisitionTimeoutMs + limits.preflightTimeoutMs + limits.postTimeoutMs;
    const totalDeadline = startedAt + bridgeLifetimeMs + limits.cleanupGraceMs;
    handshake = new DockerHandshake(owned, startedAt + limits.acquisitionTimeoutMs, signal);
    const info = dockerObject(await handshake.json('GET', '/info', 200));
    if (info.ID !== target.daemonId) throw new DockerBeeAcquisitionError();
    const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${target.profile.name}`, 'com.docker.compose.service=bee-uploader'] }));
    const containerId = listedBeeContainer(await handshake.json('GET', `/containers/json?all=0&filters=${filters}`, 200), target);
    const binding = observedBeeContainer(await handshake.json('GET', `/containers/${containerId}/json`, 200), containerId, target);
    if (typeof qualifyImage !== 'function' || qualifyImage(binding.imageId) !== true) throw new DockerBeeAcquisitionError();
    const created = dockerObject(await handshake.json('POST', `/containers/${containerId}/exec`, 201, {
      AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, Privileged: false,
      Cmd: dockerBeeBridgeCommand(binding.internalPort, bridgeLifetimeMs, limits.cleanupGraceMs),
    }));
    await handshake.upgrade(fullDockerId(created.Id));
    handshake.requireActive();
    stream = createDockerExecDuplex(owned, { maxFrameBytes: 1024 * 1024, maxOutputBytes: 8 * 1024 * 1024,
      maxInputBytes: 64 * 1024, totalTimeoutMs: Math.max(1, Math.ceil(totalDeadline - performance.now())) }, signal);
    stream.on('error', ignoreLateError);
    handshake.release();
    return Object.freeze({ stream, binding });
  } catch {
    stream?.destroy();
    handshake?.destroy();
    owned?.destroy();
    throw new DockerBeeAcquisitionError();
  }
}
