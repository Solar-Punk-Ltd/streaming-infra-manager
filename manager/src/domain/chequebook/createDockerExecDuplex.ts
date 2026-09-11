import { Duplex } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { DockerExecStreamError } from '../errors/DockerExecStreamError.js';

export interface DockerExecStreamBounds {
  readonly maxFrameBytes: number;
  readonly maxOutputBytes: number;
  readonly maxInputBytes: number;
  readonly totalTimeoutMs: number;
}

const HEADER_BYTES = 8;
const READS_PER_TURN = 64;
const ignoreLateTransportError = () => {};

function disposeTransport(transport: Duplex): void {
  // A destroyed owned transport can still emit a delayed error from its underlying process.
  transport.on('error', ignoreLateTransportError);
  if (!transport.destroyed) transport.destroy();
}

/** Takes ownership immediately. Docker stdout is framed, while bytes written to stdin are raw. */
export function createDockerExecDuplex(transport: Duplex, bounds: DockerExecStreamBounds, signal?: AbortSignal): Duplex {
  if (!bounds || typeof bounds !== 'object' || transport.destroyed || transport.readableEncoding || transport.readableObjectMode || transport.writableObjectMode ||
      ![bounds.maxFrameBytes, bounds.maxOutputBytes, bounds.maxInputBytes, bounds.totalTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0) ||
      bounds.totalTimeoutMs > 2_147_483_647) {
    disposeTransport(transport);
    throw new DockerExecStreamError();
  }
  return new DockerExecDuplex(transport, { ...bounds }, signal);
}

class DockerExecDuplex extends Duplex {
  readonly #header = Buffer.alloc(HEADER_BYTES);
  #headerBytes = 0;
  #remainingPayload = 0;
  #declaredOutputBytes = 0;
  #inputBytes = 0;
  #pressured = false;
  #pumping = false;
  #receivedEof = false;
  #scheduled: NodeJS.Immediate | undefined;
  readonly #timer: NodeJS.Timeout;
  readonly #deadline: number;

  constructor(private readonly transport: Duplex, private readonly bounds: DockerExecStreamBounds, private readonly signal?: AbortSignal) {
    super({ allowHalfOpen: true, autoDestroy: true });
    this.#deadline = performance.now() + bounds.totalTimeoutMs;
    transport.on('readable', this.onReadable);
    transport.on('end', this.onEnd);
    transport.on('error', this.onError);
    transport.on('close', this.onClose);
    signal?.addEventListener('abort', this.onAbort, { once: true });
    this.#timer = setTimeout(this.onAbort, bounds.totalTimeoutMs);
    if (signal?.aborted) this.destroy(new DockerExecStreamError());
  }

  override _read(): void {
    this.#pressured = false;
    this.pump();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.expired() || !Buffer.isBuffer(chunk) || chunk.length > this.bounds.maxInputBytes - this.#inputBytes || this.transport.destroyed || this.transport.writableEnded) {
      callback(new DockerExecStreamError());
      return;
    }
    this.#inputBytes += chunk.length;
    try { this.transport.write(chunk, error => callback(error ? new DockerExecStreamError() : undefined)); }
    catch { callback(new DockerExecStreamError()); }
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.expired()) { callback(new DockerExecStreamError()); return; }
    if (this.transport.writableFinished) { callback(); return; }
    if (this.transport.destroyed) { callback(new DockerExecStreamError()); return; }
    try { this.transport.end((error?: Error | null) => callback(error ? new DockerExecStreamError() : undefined)); }
    catch { callback(new DockerExecStreamError()); }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    clearTimeout(this.#timer);
    clearImmediate(this.#scheduled);
    this.signal?.removeEventListener('abort', this.onAbort);
    this.transport.removeListener('readable', this.onReadable);
    this.transport.removeListener('end', this.onEnd);
    this.transport.removeListener('error', this.onError);
    this.transport.removeListener('close', this.onClose);
    disposeTransport(this.transport);
    callback(error ? new DockerExecStreamError() : null);
  }

  private readonly onReadable = () => this.pump();
  private readonly onError = () => this.destroy(new DockerExecStreamError());
  private readonly onAbort = () => this.destroy(new DockerExecStreamError());
  private readonly onClose = () => { if (!this.#receivedEof) this.destroy(new DockerExecStreamError()); };
  private readonly onEnd = () => {
    if (this.expired() || this.#headerBytes || this.#remainingPayload) { this.destroy(new DockerExecStreamError()); return; }
    this.#receivedEof = true;
    this.push(null);
    if (!this.writableEnded) this.end();
  };

  private expired(): boolean { return performance.now() >= this.#deadline; }

  private pump(): void {
    if (this.destroyed) return;
    if (this.expired()) { this.destroy(new DockerExecStreamError()); return; }
    if (this.#receivedEof || this.#pressured || this.#pumping || this.#scheduled) return;
    this.#pumping = true;
    try {
      for (let reads = 0; reads < READS_PER_TURN && !this.#pressured; reads++) {
        if (this.expired() || this.transport.readableEncoding) throw new DockerExecStreamError();
        if (!this.transport.readableLength) this.transport.read(0);
        if (!this.transport.readableLength) return;
        const desired = this.#remainingPayload ? Math.min(this.#remainingPayload, this.readableHighWaterMark) : HEADER_BYTES - this.#headerBytes;
        const chunk: unknown = this.transport.read(Math.min(desired, this.transport.readableLength));
        if (this.expired() || !Buffer.isBuffer(chunk)) throw new DockerExecStreamError();
        if (this.#remainingPayload) {
          this.#remainingPayload -= chunk.length;
          this.#pressured = !this.push(chunk);
        } else {
          chunk.copy(this.#header, this.#headerBytes);
          this.#headerBytes += chunk.length;
          if (this.#headerBytes === HEADER_BYTES) this.readHeader();
        }
      }
      // A producer of empty frames must still yield to cancellation and the lifetime deadline.
      if (!this.#pressured) this.#scheduled = setImmediate(() => { this.#scheduled = undefined; this.pump(); });
    } catch { this.destroy(new DockerExecStreamError()); }
    finally { this.#pumping = false; }
  }

  private readHeader(): void {
    if (this.#header[0] !== 1 || this.#header[1] || this.#header[2] || this.#header[3]) throw new DockerExecStreamError();
    const length = this.#header.readUInt32BE(4);
    if (length > this.bounds.maxFrameBytes || length > this.bounds.maxOutputBytes - this.#declaredOutputBytes) throw new DockerExecStreamError();
    this.#declaredOutputBytes += length;
    this.#remainingPayload = length;
    this.#headerBytes = 0;
  }
}
