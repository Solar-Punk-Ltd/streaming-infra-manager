import { Duplex } from 'node:stream';
import { BeeConnectionError } from '../errors/BeeConnectionError.js';

const ignoreLateError = () => {};

/** An acquired byte stream with the lifecycle hooks used by Node's HTTP agent and client. */
export class OwnedHttpStream extends Duplex {
  readonly connecting = false;
  timeout = 0;
  #timer: NodeJS.Timeout | undefined;
  #referenced = true;
  #ended = false;
  #pressured = false;

  constructor(private readonly transport: Duplex) {
    super({ allowHalfOpen: true });
    transport.on('error', this.onError);
    transport.on('close', this.onClose);
    transport.on('end', this.onEnd);
    transport.on('readable', this.onReadable);
    if (transport.destroyed || transport.readableEnded || transport.writableEnded || transport.readableEncoding || transport.readableObjectMode || transport.writableObjectMode) {
      this.destroy();
      throw new BeeConnectionError();
    }
  }

  setTimeout(milliseconds: number, callback?: () => void): this {
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 2_147_483_647) throw new BeeConnectionError();
    this.timeout = milliseconds;
    if (callback) this.once('timeout', callback);
    this.touch();
    return this;
  }

  setKeepAlive(enable = false, initialDelay = 0): this {
    if ('setKeepAlive' in this.transport && typeof this.transport.setKeepAlive === 'function') this.transport.setKeepAlive(enable, initialDelay);
    return this;
  }

  setNoDelay(enable = true): this {
    if ('setNoDelay' in this.transport && typeof this.transport.setNoDelay === 'function') this.transport.setNoDelay(enable);
    return this;
  }

  ref(): this {
    this.#referenced = true;
    this.#timer?.ref();
    if ('ref' in this.transport && typeof this.transport.ref === 'function') this.transport.ref();
    return this;
  }

  unref(): this {
    this.#referenced = false;
    this.#timer?.unref();
    if ('unref' in this.transport && typeof this.transport.unref === 'function') this.transport.unref();
    return this;
  }

  override _read(): void { this.#pressured = false; this.pump(); }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!Buffer.isBuffer(chunk) || this.transport.destroyed || this.transport.writableEnded) { callback(new BeeConnectionError()); return; }
    this.touch();
    try { this.transport.write(chunk, error => { this.touch(); callback(error ? new BeeConnectionError() : undefined); }); }
    catch { callback(new BeeConnectionError()); }
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.transport.writableFinished) { callback(); return; }
    if (this.transport.destroyed) { callback(new BeeConnectionError()); return; }
    try { this.transport.end((error?: Error | null) => callback(error ? new BeeConnectionError() : undefined)); }
    catch { callback(new BeeConnectionError()); }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    clearTimeout(this.#timer);
    this.transport.removeListener('readable', this.onReadable);
    this.transport.removeListener('end', this.onEnd);
    this.transport.removeListener('error', this.onError);
    this.transport.removeListener('close', this.onClose);
    this.transport.on('error', ignoreLateError);
    if (!this.transport.destroyed) this.transport.destroy();
    callback(error ? new BeeConnectionError() : null);
  }

  private readonly onReadable = () => this.pump();
  private readonly onError = () => this.destroy(new BeeConnectionError());
  private readonly onClose = () => { if (!this.#ended) this.destroy(new BeeConnectionError()); };
  private readonly onEnd = () => { this.#ended = true; this.push(null); };

  private touch(): void {
    clearTimeout(this.#timer);
    if (!this.timeout || this.destroyed) return;
    this.#timer = setTimeout(() => this.emit('timeout'), this.timeout);
    if (!this.#referenced) this.#timer.unref();
  }

  private pump(): void {
    if (this.destroyed || this.#ended || this.#pressured) return;
    try {
      while (!this.#pressured) {
        if (this.transport.readableEncoding) throw new BeeConnectionError();
        if (!this.transport.readableLength) this.transport.read(0);
        if (!this.transport.readableLength) return;
        const chunk: unknown = this.transport.read(Math.min(this.transport.readableLength, this.readableHighWaterMark));
        if (!Buffer.isBuffer(chunk)) throw new BeeConnectionError();
        this.touch();
        this.#pressured = !this.push(chunk);
      }
    } catch { this.destroy(new BeeConnectionError()); }
  }
}
