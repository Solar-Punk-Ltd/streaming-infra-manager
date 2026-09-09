import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { finished } from 'node:stream/promises';
import { describe, it } from 'node:test';
import { createDockerExecDuplex } from '../../src/domain/chequebook/createDockerExecDuplex.js';
import { DockerExecStreamError } from '../../src/domain/errors/DockerExecStreamError.js';

class SyntheticTransport extends Duplex {
  readonly input: Buffer[] = [];
  destroyedCount = 0;
  finishedInput = false;
  holdWrites = false;
  pendingWrite: (() => void) | undefined;
  constructor() { super({ allowHalfOpen: true }); }
  override _read() {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.input.push(Buffer.from(chunk));
    if (this.holdWrites) this.pendingWrite = callback;
    else callback();
  }
  override _final(callback: (error?: Error | null) => void) { this.finishedInput = true; callback(); }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void) { this.destroyedCount++; callback(error); }
}

const bounds = { maxFrameBytes: 64 * 1024, maxOutputBytes: 256 * 1024, maxInputBytes: 256 * 1024, totalTimeoutMs: 2000 };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function header(length: number, stream = 1): Buffer {
  const bytes = Buffer.alloc(8);
  bytes[0] = stream;
  bytes.writeUInt32BE(length, 4);
  return bytes;
}
function frame(bytes: Buffer, stream = 1): Buffer { return Buffer.concat([header(bytes.length, stream), bytes]); }
async function collect(stream: Duplex): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    assert.ok(Buffer.isBuffer(chunk));
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function refuses(feed: (raw: SyntheticTransport, stream: Duplex) => void, options = bounds, immediate = true) {
  const raw = new SyntheticTransport();
  const stream = createDockerExecDuplex(raw, options);
  const outcome = assert.rejects(finished(stream), error => error instanceof DockerExecStreamError && error.cause === undefined && !error.message.includes('sensitive'));
  stream.resume();
  feed(raw, stream);
  if (immediate) { await turn(); assert.equal(stream.destroyed, true, 'protocol refusal must not wait for the lifetime timer'); }
  await outcome;
  assert.equal(raw.destroyedCount, 1);
  stream.destroy(); raw.emit('error', new Error('sensitive late upstream diagnostic'));
  assert.equal(raw.destroyedCount, 1);
}

describe('strict binary Docker exec duplex', { timeout: 5000 }, () => {
  for (let split = 1; split < 8; split++) {
    it(`preserves bytes with a header split after byte ${split}`, async () => {
      const raw = new SyntheticTransport();
      const stream = createDockerExecDuplex(raw, bounds);
      const payload = Buffer.from([0, 255, 254, 128, 13, 10, 0, 1]);
      const bytes = frame(payload);
      const output = collect(stream);
      raw.push(bytes.subarray(0, split));
      await turn();
      raw.push(bytes.subarray(split)); raw.push(null);
      assert.deepEqual(await output, payload);
      assert.equal(raw.destroyedCount, 1);
    });
  }

  it('preserves split payloads and adjacent frames without decoding bytes as text', async () => {
    const raw = new SyntheticTransport();
    const stream = createDockerExecDuplex(raw, bounds);
    const expected = Buffer.from([0, 0xc3, 0x28, 255, 128, 13, 10, 42]);
    const bytes = Buffer.concat([frame(expected.subarray(0, 4)), frame(Buffer.alloc(0)), frame(expected.subarray(4))]);
    const output = collect(stream);
    for (const byte of bytes) { raw.push(Buffer.from([byte])); await turn(); }
    raw.push(null);
    assert.deepEqual(await output, expected);
    assert.equal(raw.destroyedCount, 1);
  });

  it('passes input bytes unchanged and keeps reading after a normal writable half-close', async () => {
    const raw = new SyntheticTransport();
    const stream = createDockerExecDuplex(raw, bounds);
    const output = collect(stream);
    const input = Buffer.from([0, 255, 0xc3, 0x28, 13, 10]);
    await new Promise<void>((resolve, reject) => stream.end(input, (error?: Error | null) => error ? reject(error) : resolve()));
    assert.deepEqual(Buffer.concat(raw.input), input);
    assert.equal(raw.finishedInput, true);
    assert.equal(raw.destroyed, false);
    const reply = Buffer.from('reply after stdin EOF');
    raw.push(frame(reply)); raw.push(null);
    assert.deepEqual(await output, reply);
    assert.equal(raw.destroyedCount, 1);
  });

  it('propagates write-side pressure until the owned transport accepts the bytes', async () => {
    const raw = new SyntheticTransport(); raw.holdWrites = true;
    const stream = createDockerExecDuplex(raw, bounds);
    const result = finished(stream); stream.resume();
    let acknowledged = false;
    assert.equal(stream.write(Buffer.alloc(64 * 1024, 0xfe), () => { acknowledged = true; }), false);
    await turn();
    assert.equal(acknowledged, false);
    raw.pendingWrite!();
    await turn();
    assert.equal(acknowledged, true);
    assert.equal(Buffer.concat(raw.input).length, 64 * 1024);
    stream.end(); raw.push(null); await result;
    assert.equal(raw.destroyedCount, 1);
  });

  it('stops pulling framed bytes while its output consumer is slow', async () => {
    const raw = new SyntheticTransport();
    const stream = createDockerExecDuplex(raw, { ...bounds, maxFrameBytes: 256 * 1024 });
    const payload = Buffer.alloc(192 * 1024, 0xfa);
    raw.push(frame(payload));
    await turn(); await turn();
    assert.ok(raw.readableLength > 0, 'the raw payload must remain under upstream pressure');
    assert.ok(stream.readableLength <= stream.readableHighWaterMark, 'the decoder must not queue the entire frame');
    const output = collect(stream); raw.push(null);
    assert.deepEqual(await output, payload);
    assert.equal(raw.destroyedCount, 1);
  });

  for (const type of [0, 2, 3, 255]) {
    it(`refuses incoming Docker stream type ${type}`, () => refuses(raw => raw.push(frame(Buffer.from('sensitive stderr'), type))));
  }
  for (const offset of [1, 2, 3]) {
    it(`refuses a nonzero reserved header byte at ${offset}`, () => refuses(raw => {
      const bytes = header(1); bytes[offset] = 1; raw.push(bytes);
    }));
  }
  it('refuses oversized declared output before receiving or buffering its payload', () => refuses(raw => raw.push(header(0xffff_ffff))));
  it('refuses declared cumulative output before receiving the next payload', () => refuses(raw => {
    raw.push(frame(Buffer.from([1, 2, 3]))); raw.push(header(3));
  }, { ...bounds, maxOutputBytes: 5 }));
  it('refuses input beyond its cumulative byte budget without writing the excess bytes', async () => {
    let rawRef: SyntheticTransport;
    await refuses((raw, stream) => { rawRef = raw; stream.write(Buffer.from([1, 2, 3])); stream.write(Buffer.from([4, 5, 6])); }, { ...bounds, maxInputBytes: 5 });
    assert.deepEqual(Buffer.concat(rawRef!.input), Buffer.from([1, 2, 3]));
  });
  for (let length = 1; length < 8; length++) {
    it(`refuses EOF with ${length} partial header bytes`, () => refuses(raw => { raw.push(header(4).subarray(0, length)); raw.push(null); }));
  }
  it('refuses truncated payload EOF', () => refuses(raw => { raw.push(Buffer.concat([header(4), Buffer.from([1, 2])])); raw.push(null); }));
  it('refuses transport closure without clean EOF', () => refuses(raw => raw.destroy()));
  it('contains upstream error messages', () => refuses(raw => raw.destroy(new Error('sensitive upstream diagnostic'))));
  it('refuses a string-producing transport instead of re-encoding it', () => refuses(raw => { raw.setEncoding('utf8'); raw.push(frame(Buffer.from([255, 254]))); }));
  for (const value of ['nonbinary bytes', { diagnostic: 'sensitive object chunk' }]) {
    it(`refuses ${typeof value} chunks without relying on an encoding flag`, () => refuses(raw => {
      const read = raw.read.bind(raw);
      raw.read = size => { const chunk = read(size); return Buffer.isBuffer(chunk) ? value : chunk; };
      raw.push(frame(Buffer.from([255])));
    }));
  }
  it('contains a synchronous transport write failure and cleans up', () => refuses((raw, stream) => {
    raw.write = () => { throw new Error('sensitive write diagnostic'); };
    stream.write(Buffer.from([255]));
  }));
  it('refuses an encoded transport at construction and disposes it once', () => {
    const raw = new SyntheticTransport(); raw.setEncoding('utf8');
    assert.throws(() => createDockerExecDuplex(raw, bounds), DockerExecStreamError);
    assert.equal(raw.destroyedCount, 1);
    raw.emit('error', new Error('sensitive late diagnostic'));
  });
  it('contains cancellation details and disposes both sides once', async () => {
    const raw = new SyntheticTransport();
    const controller = new AbortController();
    const stream = createDockerExecDuplex(raw, bounds, controller.signal);
    const outcome = finished(stream); stream.resume();
    controller.abort(new Error('sensitive cancellation detail'));
    await assert.rejects(outcome, error => error instanceof DockerExecStreamError && !error.message.includes('sensitive'));
    stream.destroy(); controller.abort(); raw.emit('error', new Error('sensitive late diagnostic'));
    assert.equal(raw.destroyedCount, 1);
  });
  it('enforces its total lifetime without traffic', () => refuses(() => {}, { ...bounds, totalTimeoutMs: 15 }, false));
  for (const boundary of ['write', 'read', 'final', 'eof'] as const) {
    it(`refuses ${boundary} after monotonic expiry before its timer can run`, async () => {
      const raw = new SyntheticTransport();
      const stream = createDockerExecDuplex(raw, { ...bounds, totalTimeoutMs: 20 });
      const outcome = assert.rejects(finished(stream), DockerExecStreamError);
      let reads = 0;
      const read = raw.read.bind(raw);
      raw.read = size => { reads++; return read(size); };
      const until = performance.now() + 30;
      while (performance.now() < until) { /* Delay the timer without yielding this turn. */ }
      assert.equal(raw.destroyed, false);
      if (boundary === 'write') stream.write(Buffer.from([255]));
      if (boundary === 'final') stream.end();
      if (boundary === 'eof') raw.emit('end');
      if (boundary === 'read') { raw.push(frame(Buffer.from([255]))); assert.equal(stream.read(), null); }
      assert.equal(raw.input.length, 0);
      assert.equal(raw.finishedInput, false);
      assert.equal(reads, 0);
      await outcome;
      assert.equal(raw.destroyedCount, 1);
      raw.emit('error', new Error('sensitive late diagnostic'));
    });
  }
  it('allows bytes and a normal half-close within the total lifetime', async () => {
    const raw = new SyntheticTransport();
    const stream = createDockerExecDuplex(raw, { ...bounds, totalTimeoutMs: 500 });
    const output = collect(stream);
    stream.end(Buffer.from([0, 255]));
    raw.push(frame(Buffer.from([128, 1]))); raw.push(null);
    assert.deepEqual(await output, Buffer.from([128, 1]));
    assert.deepEqual(Buffer.concat(raw.input), Buffer.from([0, 255]));
    assert.equal(raw.finishedInput, true); assert.equal(raw.destroyedCount, 1);
  });
  it('does not flush a queued write after an earlier in-budget write completes beyond expiry', async () => {
    const raw = new SyntheticTransport(); raw.holdWrites = true;
    const stream = createDockerExecDuplex(raw, { ...bounds, totalTimeoutMs: 20 });
    const outcome = assert.rejects(finished(stream), DockerExecStreamError);
    stream.write(Buffer.from([1])); stream.write(Buffer.from([2]));
    const until = performance.now() + 30;
    while (performance.now() < until) { /* Keep the expiry callback pending. */ }
    raw.holdWrites = false; raw.pendingWrite!();
    assert.deepEqual(Buffer.concat(raw.input), Buffer.from([1]));
    await outcome;
    assert.equal(raw.destroyedCount, 1);
  });
  it('handles cancellation that already happened before acquisition without exposing its reason', async () => {
    const raw = new SyntheticTransport();
    const controller = new AbortController(); controller.abort(new Error('sensitive old reason'));
    const stream = createDockerExecDuplex(raw, bounds, controller.signal);
    await assert.rejects(finished(stream), error => error instanceof DockerExecStreamError && !error.message.includes('sensitive'));
    assert.equal(raw.destroyedCount, 1);
  });
  it('contains a delayed write failure after cancellation and disposes only once', async () => {
    const raw = new SyntheticTransport(); raw.holdWrites = true;
    const controller = new AbortController();
    const stream = createDockerExecDuplex(raw, bounds, controller.signal);
    const outcome = assert.rejects(finished(stream), DockerExecStreamError);
    let callbacks = 0;
    stream.write(Buffer.from([255]), () => { callbacks++; });
    controller.abort();
    await outcome;
    raw.pendingWrite!(); raw.emit('error', new Error('sensitive delayed write diagnostic'));
    await turn();
    assert.equal(callbacks, 1);
    assert.equal(raw.destroyedCount, 1);
  });
  it('accepts empty clean output and contains an error emitted after cleanup', async () => {
    const raw = new SyntheticTransport();
    const stream = createDockerExecDuplex(raw, bounds);
    const output = collect(stream); raw.push(null);
    assert.deepEqual(await output, Buffer.alloc(0));
    assert.equal(raw.destroyedCount, 1);
    raw.emit('error', new Error('sensitive late diagnostic'));
  });
  it('does not let empty frames starve cancellation or the total deadline', async () => {
    const raw = new SyntheticTransport();
    raw._read = () => { raw.push(header(0)); };
    const stream = createDockerExecDuplex(raw, { ...bounds, totalTimeoutMs: 15 });
    const outcome = finished(stream); stream.resume();
    await assert.rejects(outcome, DockerExecStreamError);
    assert.equal(raw.destroyedCount, 1);
  });
  it('treats explicit destruction as distinct from a normal input half-close', async () => {
    const raw = new SyntheticTransport();
    const stream = createDockerExecDuplex(raw, bounds);
    const closed = new Promise<void>(resolve => stream.once('close', resolve));
    stream.destroy(); stream.destroy();
    await closed;
    assert.equal(raw.finishedInput, false);
    assert.equal(raw.destroyedCount, 1);
    raw.emit('error', new Error('sensitive late diagnostic'));
  });
  for (const invalid of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    it(`rejects invalid byte bounds ${invalid} and disposes its owned transport`, () => {
      const raw = new SyntheticTransport();
      assert.throws(() => createDockerExecDuplex(raw, { ...bounds, maxFrameBytes: invalid }), DockerExecStreamError);
      assert.equal(raw.destroyedCount, 1);
    });
  }
  for (const missing of [undefined, null]) {
    it(`disposes its transport when the bounds object is ${missing}`, () => {
      const raw = new SyntheticTransport();
      assert.throws(() => createDockerExecDuplex(raw, missing as never), DockerExecStreamError);
      assert.equal(raw.destroyedCount, 1);
    });
  }
});
