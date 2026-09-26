import http from 'node:http';
import { performance } from 'node:perf_hooks';
import type { Duplex } from 'node:stream';
import { DockerBeeAcquisitionError } from '../errors/DockerBeeAcquisitionError.js';
import type { FrozenChequebookTarget } from './FrozenChequebookTarget.js';
import { OwnedHttpStream } from './OwnedHttpStream.js';
import { createDockerExecDuplex } from './createDockerExecDuplex.js';
import { dockerObject, fullDockerId, listedBeeContainer, nodeChainEndpoint, observedBeeContainer, type ObservedBeeContainer } from './DockerBeeBinding.js';
import { dockerBeeBridgeCommand } from './dockerBeeBridge.js';
import { DOCKER_BEE_STREAM_BOUNDS, dockerEngineVersion, observedBeeBridgeExecution, type BeeBridgeExecution,
  type QualifiedBeeBridgeExecution } from './beeBridgeQualification.js';

export interface DockerBeeAcquisitionOptions {
  acquisitionTimeoutMs?: number;
  preflightTimeoutMs?: number;
  postTimeoutMs?: number;
  cleanupGraceMs?: number;
}
export interface AcquiredDockerBeeStream {
  readonly stream: Duplex;
  readonly binding: ObservedBeeContainer;
  /** What the node's container was started with for --blockchain-rpc-endpoint, or null. Never logged or answered. */
  readonly chainEndpoint: string | null;
}
/** Trusted qualification of the exact immutable image, never a request field or an operator assertion. */
export type { QualifiedBeeBridgeExecution } from './beeBridgeQualification.js';
type Budgets = Required<DockerBeeAcquisitionOptions>;
const MAX_JSON_BYTES = 1024 * 1024;
const ignoreLateError = () => {};

export function normalizeDockerBeeAcquisitionOptions(input: DockerBeeAcquisitionOptions): Readonly<Budgets> {
  if (!input || typeof input !== 'object') throw new DockerBeeAcquisitionError();
  const value = { acquisitionTimeoutMs: input.acquisitionTimeoutMs ?? 15_000, preflightTimeoutMs: input.preflightTimeoutMs ?? 30_000,
    postTimeoutMs: input.postTimeoutMs ?? 180_000, cleanupGraceMs: input.cleanupGraceMs ?? 5000 };
  for (const [amount, maximum] of [[value.acquisitionTimeoutMs, 30_000], [value.preflightTimeoutMs, 60_000], [value.postTimeoutMs, 180_000], [value.cleanupGraceMs, 10_000]]) {
    if (!Number.isSafeInteger(amount) || amount! < 1 || amount! > maximum!) throw new DockerBeeAcquisitionError();
  }
  return Object.freeze(value);
}

function requireTarget(target: FrozenChequebookTarget): void {
  if (target?.version !== 1 || typeof target.daemonId !== 'string' || !target.daemonId.trim() || target.daemonId.length > 200 ||
      typeof target.profile?.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(target.profile.name) ||
      target.reservation?.service !== 'bee-uploader' || target.reservation.portVar !== 'BEE_UPLOADER_API_PORT' || target.reservation.protocol !== 'tcp' ||
      !Number.isSafeInteger(target.reservation.port) || target.reservation.port < 1 || target.reservation.port > 65535) throw new DockerBeeAcquisitionError('target_changed');
}

/** One HTTP conversation with Docker over a connection it owns, ending in at most one upgraded exec stream. */
export class DockerHandshake extends http.Agent {
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

/** A connection's own Docker conversation, and the deadlines one acquisition over it keeps. */
export interface OwnedDockerConversation {
  readonly owned: OwnedHttpStream;
  readonly handshake: DockerHandshake;
  readonly target: FrozenChequebookTarget;
  readonly limits: Readonly<Required<DockerBeeAcquisitionOptions>>;
  readonly bridgeLifetimeMs: number;
  /** When the acquisition over this connection must have finished. */
  readonly deadline: number;
  /** When everything an exec stream opened here may still do must have ended. */
  readonly totalDeadline: number;
}

/** Takes ownership of one Docker connection for one acquisition. The optional cap is a local monotonic deadline, never an API field. */
export function openDockerConversation(transport: Duplex, expected: FrozenChequebookTarget, options: DockerBeeAcquisitionOptions,
  signal?: AbortSignal, acquisitionDeadline?: number): OwnedDockerConversation {
  const startedAt = performance.now();
  const owned = new OwnedHttpStream(transport);
  owned.on('error', ignoreLateError);
  try {
    const target = structuredClone(expected);
    const limits = normalizeDockerBeeAcquisitionOptions(structuredClone(options));
    requireTarget(target);
    if (acquisitionDeadline !== undefined && (typeof acquisitionDeadline !== 'number' || !Number.isFinite(acquisitionDeadline))) throw new DockerBeeAcquisitionError();
    const deadline = Math.min(startedAt + limits.acquisitionTimeoutMs, acquisitionDeadline ?? Infinity);
    const bridgeLifetimeMs = deadline - startedAt + limits.preflightTimeoutMs + limits.postTimeoutMs;
    const totalDeadline = deadline + limits.preflightTimeoutMs + limits.postTimeoutMs + limits.cleanupGraceMs;
    return { owned, handshake: new DockerHandshake(owned, deadline, signal), target, limits, bridgeLifetimeMs, deadline, totalDeadline };
  } catch (error) { owned.destroy(); throw error; }
}

/** What Docker says about the container the bridge would run in, read over one conversation. */
export interface ObservedBeeBridgeTarget {
  readonly containerId: string;
  readonly binding: ObservedBeeContainer;
  readonly execution: BeeBridgeExecution;
  readonly chainEndpoint: string | null;
}

/** Reads the daemon, the one running Bee container of the deployment, its inspect and its image. Starts nothing. */
export async function observeBeeBridgeTarget(conversation: OwnedDockerConversation): Promise<ObservedBeeBridgeTarget> {
  const { handshake, target, limits } = conversation;
  const info = dockerObject(await handshake.json('GET', '/info', 200));
  if (info.ID !== target.daemonId) throw new DockerBeeAcquisitionError('target_changed');
  const engineVersion = dockerEngineVersion(info);
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${target.profile.name}`, 'com.docker.compose.service=bee-uploader'] }));
  const containerId = listedBeeContainer(await handshake.json('GET', `/containers/json?all=0&filters=${filters}`, 200), target);
  const inspect = await handshake.json('GET', `/containers/${containerId}/json`, 200);
  const binding = observedBeeContainer(inspect, containerId, target);
  const image = await handshake.json('GET', `/images/${binding.imageId}/json`, 200);
  const execution = observedBeeBridgeExecution(engineVersion, image, binding.imageId, conversation.bridgeLifetimeMs, limits.cleanupGraceMs);
  return Object.freeze({ containerId, binding, execution, chainEndpoint: nodeChainEndpoint(inspect) });
}

/** Owns one supplied Docker API connection. The optional cap is a local monotonic deadline, never an API field. */
export async function acquireDockerBeeStream(transport: Duplex, expected: FrozenChequebookTarget, options: DockerBeeAcquisitionOptions = {},
  qualifyImage: QualifiedBeeBridgeExecution = () => false, signal?: AbortSignal, acquisitionDeadline?: number): Promise<AcquiredDockerBeeStream> {
  let owned: OwnedHttpStream | undefined;
  let handshake: DockerHandshake | undefined;
  let stream: Duplex | undefined;
  try {
    const conversation = openDockerConversation(transport, expected, options, signal, acquisitionDeadline);
    ({ owned, handshake } = conversation);
    const { limits, bridgeLifetimeMs, totalDeadline } = conversation;
    const { containerId, binding, execution, chainEndpoint } = await observeBeeBridgeTarget(conversation);
    if (typeof qualifyImage !== 'function' || await qualifyImage(execution, binding) !== true) throw new DockerBeeAcquisitionError('bridge_not_qualified');
    handshake.requireActive();
    const created = dockerObject(await handshake.json('POST', `/containers/${containerId}/exec`, 201, {
      AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, Privileged: false,
      Cmd: dockerBeeBridgeCommand(binding.internalPort, bridgeLifetimeMs, limits.cleanupGraceMs),
    }));
    await handshake.upgrade(fullDockerId(created.Id));
    handshake.requireActive();
    stream = createDockerExecDuplex(owned, { ...DOCKER_BEE_STREAM_BOUNDS, totalTimeoutMs: Math.max(1, Math.ceil(totalDeadline - performance.now())) }, signal);
    stream.on('error', ignoreLateError);
    handshake.release();
    return Object.freeze({ stream, binding, chainEndpoint });
  } catch (error) {
    stream?.destroy();
    handshake?.destroy();
    owned?.destroy();
    if (!owned) transport.destroy();
    throw DockerBeeAcquisitionError.keeping(error);
  }
}
