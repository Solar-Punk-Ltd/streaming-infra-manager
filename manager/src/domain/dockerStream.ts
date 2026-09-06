import type { Readable } from 'node:stream';

/**
 * Docker's attach protocol, decoded.
 *
 * A container that was started without a TTY does not hand back plain bytes.
 * Its stdout and stderr arrive interleaved in one connection, each write
 * wrapped in an eight byte header: one byte saying which stream it was, three
 * zero bytes, then the payload length as a big-endian uint32. Reading such a
 * response as text puts eight bytes of control characters in front of every
 * write, which is exactly how a log viewer that skips this step looks.
 *
 * Both streams are kept and interleaved as they arrived, because that is the
 * order the container wrote them in and a log split by stream reads as two
 * unrelated halves.
 */
const HEADER_BYTES = 8;
const LENGTH_OFFSET = 4;

/** 0 stdin, 1 stdout, 2 stderr. Anything else is not a header. */
const MAX_STREAM_TYPE = 2;

export function demultiplexDockerStream(raw: Buffer): string {
  // A container started with a TTY writes raw bytes with no framing at all, so
  // decoding those as frames would eat eight characters out of every write.
  if (!looksFramed(raw)) return raw.toString('utf8');

  const payloads: Buffer[] = [];
  let offset = 0;
  while (offset + HEADER_BYTES <= raw.length) {
    const declared = raw.readUInt32BE(offset + LENGTH_OFFSET);
    const start = offset + HEADER_BYTES;
    // Clamped rather than trusted: a response cut short mid-frame is normal
    // when the reader stops at a byte cap.
    const end = Math.min(start + declared, raw.length);
    payloads.push(raw.subarray(start, end));
    offset = end;
  }
  return Buffer.concat(payloads).toString('utf8');
}

function looksFramed(raw: Buffer): boolean {
  return (
    raw.length >= HEADER_BYTES &&
    (raw[0] ?? -1) <= MAX_STREAM_TYPE &&
    raw[1] === 0 &&
    raw[2] === 0 &&
    raw[3] === 0
  );
}

/** How much of a stream to take, and how long to wait for it. */
export interface StreamBounds {
  /** Stop at this many bytes, whatever is still coming. */
  maxBytes: number;
  /**
   * Stop when nothing has arrived for this long since the first chunk.
   *
   * A followed log stream delivers the tail and then stays open for lines that
   * have not happened yet, which looks exactly like a slow container except for
   * the gap. Left out, only the byte cap and the end of the stream stop it.
   */
  idleMs?: number;
  /** Stop this long after the read started, however it is going. */
  totalMs?: number;
}

/**
 * Reads a Docker stream under bounds, then closes it.
 *
 * Every caller here is answering an HTTP request, so none of them may wait on a
 * container that never stops writing or a daemon that stops answering halfway.
 */
export function readBounded(
  stream: NodeJS.ReadableStream,
  bounds: StreamBounds,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let idleTimer: NodeJS.Timeout | undefined;
    let totalTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const stop = (failure?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      destroyStream(stream);
      if (failure) reject(failure);
      else resolve(Buffer.concat(chunks).subarray(0, bounds.maxBytes));
    };

    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      size += buffer.length;
      if (size >= bounds.maxBytes) {
        stop();
        return;
      }
      if (bounds.idleMs !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => stop(), bounds.idleMs);
      }
    };
    const onEnd = (): void => stop();
    const onError = (err: unknown): void => stop(err);

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);

    if (bounds.totalMs !== undefined) {
      totalTimer = setTimeout(() => stop(), bounds.totalMs);
    }
  });
}

function destroyStream(stream: NodeJS.ReadableStream): void {
  (stream as Partial<Readable>).destroy?.();
}
