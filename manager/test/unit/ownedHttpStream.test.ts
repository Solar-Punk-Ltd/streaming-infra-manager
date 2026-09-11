import assert from 'node:assert/strict';
import http from 'node:http';
import { Duplex, PassThrough } from 'node:stream';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import { OwnedHttpStream } from '../../src/domain/chequebook/OwnedHttpStream.js';

describe('owned HTTP stream lifecycle', { timeout: 2000 }, () => {
  it('implements native HTTP timeout and no-delay delegation without a connect event', async t => {
    const inbound = new PassThrough();
    const outbound = new PassThrough();
    const raw = Duplex.from({ readable: inbound, writable: outbound });
    const calls: unknown[][] = [];
    Object.assign(raw, {
      setNoDelay: (...args: unknown[]) => calls.push(['noDelay', ...args]),
      setKeepAlive: (...args: unknown[]) => calls.push(['keepAlive', ...args]),
      ref: () => calls.push(['ref']), unref: () => calls.push(['unref']),
    });
    const stream = new OwnedHttpStream(raw);
    stream.on('error', () => {});
    t.after(() => stream.destroy());
    const request = http.request('http://bee.invalid/', { createConnection: () => stream });
    request.on('error', () => {});
    t.after(() => request.destroy());
    request.setNoDelay(true);
    request.setSocketKeepAlive(true, 100);
    request.setTimeout(25);
    const timeout = once(request, 'timeout');
    request.end();
    await timeout;
    assert.equal(stream.connecting, false);
    assert.equal(stream.timeout, 25);
    assert.ok(calls.some(call => call[0] === 'noDelay' && call[1] === true));
    assert.ok(calls.some(call => call[0] === 'keepAlive' && call[2] === 100));
    assert.equal(stream.ref(), stream);
    assert.equal(stream.unref(), stream);
    assert.ok(calls.some(call => call[0] === 'ref'));
    assert.ok(calls.some(call => call[0] === 'unref'));
    stream.setTimeout(0);
    assert.equal(stream.timeout, 0);
  });

  it('preserves binary writes, write backpressure and writable half-close', async t => {
    const received: Buffer[] = [];
    let release: (() => void) | undefined;
    const raw = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) { received.push(chunk); release = callback; },
    });
    const stream = new OwnedHttpStream(raw);
    stream.on('error', () => {});
    t.after(() => stream.destroy());
    let completed = false;
    const bytes = Buffer.alloc(128 * 1024, 255);
    assert.equal(stream.write(bytes, () => { completed = true; }), false);
    assert.equal(completed, false);
    release!();
    const finished = once(stream, 'finish');
    stream.end();
    await finished;
    assert.equal(raw.writableEnded, true);
    assert.equal(raw.destroyed, false);
    assert.deepEqual(Buffer.concat(received), bytes);
    const payload = once(stream, 'data');
    raw.push(Buffer.from([0, 255, 128]));
    assert.deepEqual((await payload)[0], Buffer.from([0, 255, 128]));
    raw.push(null);
    await once(stream, 'close');
    assert.equal(raw.destroyed, true);
  });

  it('bounds buffered output for a slow consumer and resumes without loss', async t => {
    const raw = new PassThrough();
    const stream = new OwnedHttpStream(raw);
    stream.on('error', () => {});
    t.after(() => stream.destroy());
    const bytes = Buffer.alloc(512 * 1024, 128);
    raw.write(bytes);
    stream.read(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(stream.readableLength <= stream.readableHighWaterMark);
    assert.ok(raw.readableLength > 0);
    let read = 0;
    for await (const chunk of stream) {
      read += chunk.length;
      if (read === bytes.length) break;
    }
    assert.equal(read, bytes.length);
  });
});
