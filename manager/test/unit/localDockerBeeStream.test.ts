import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it, type TestContext } from 'node:test';
import { acquireLocalDockerBeeStream, openUnixDockerConnection, type LocalDockerLocator } from '../../src/domain/chequebook/acquireLocalDockerBeeStream.js';
import { acquireDockerBeeStream } from '../../src/domain/chequebook/acquireDockerBeeStream.js';
import type { BeeBridgeExecution } from '../../src/domain/chequebook/beeBridgeQualification.js';
import { PinnedBeeSession } from '../../src/domain/chequebook/PinnedBeeSession.js';
import { syntheticDockerBee, syntheticImageId, syntheticTarget } from '../support/syntheticDockerBee.js';
import { transactionHash, transferContext } from '../support/chequebookOperations.js';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const block = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) {} };
const locator = (): LocalDockerLocator => ({ kind: 'unix', alias: syntheticTarget.alias, socketPath: '/synthetic/only.sock' });
const qualified = (execution: BeeBridgeExecution) => execution.imageId === syntheticImageId;
const limits = { acquisitionTimeoutMs: 200, preflightTimeoutMs: 200, postTimeoutMs: 200, cleanupGraceMs: 20 };
function harness(t: TestContext) {
  const docker = syntheticDockerBee(t);
  let opens = 0;
  let ready: () => Promise<void> = async () => {};
  const connect = (path: string) => { opens++; assert.equal(path, '/synthetic/only.sock'); return { stream: docker.transport, connected: ready() }; };
  return { docker, connect, opens: () => opens, onReady(value: () => Promise<void>) { ready = value; } };
}

describe('local owned Docker connection', { timeout: 5000 }, () => {
  it('preserves an absolute acquisition cap across handshake cloning delay before protocol I/O', async t => {
    const h = harness(t); const original = structuredClone;
    t.mock.method(globalThis, 'structuredClone', (value: unknown) => { block(35); return original(value); });
    const cap = performance.now() + 20;
    const result = await acquireDockerBeeStream(h.docker.transport, syntheticTarget, limits, qualified, undefined, cap)
      .then(value => { value.stream.destroy(); return 'completed'; }, () => 'refused');
    assert.equal(result, 'refused'); assert.equal(h.docker.dockerRequests.length, 0); assert.equal(h.docker.transport.destroyed, true);
  });

  for (const cap of [NaN, Infinity, -Infinity, performance.now() - 1000, '20000']) {
    it(`disposes before protocol I/O for invalid or expired absolute acquisition cap ${String(cap)}`, async t => {
      const h = harness(t);
      await assert.rejects(acquireDockerBeeStream(h.docker.transport, syntheticTarget, limits, qualified, undefined, cap as number));
      assert.equal(h.docker.dockerRequests.length, 0); assert.equal(h.docker.transport.destroyed, true);
    });
  }

  it('does not allow a later absolute cap to extend the handshake normalized acquisition allowance', async t => {
    const h = harness(t); h.docker.peer.pause();
    const began = performance.now();
    await assert.rejects(acquireDockerBeeStream(h.docker.transport, syntheticTarget, { ...limits, acquisitionTimeoutMs: 20 }, qualified, undefined, began + 1000));
    assert.ok(performance.now() - began < 250); assert.equal(h.docker.transport.destroyed, true);
  });

  it('performs the accepted handshake and successive Bee reads then one POST over one supplied connection', async t => {
    const h = harness(t);
    const acquired = await acquireLocalDockerBeeStream(syntheticTarget, async alias => {
      assert.equal(alias, syntheticTarget.alias); return locator();
    }, limits, qualified, undefined, h.connect);
    const session = PinnedBeeSession.fromStream(acquired.stream);
    t.after(() => session.dispose());
    assert.equal((await session.getAddresses()).ethereum, transferContext.nodeAddress);
    await session.getWallet(); await session.getChequebookAddress();
    assert.deepEqual(await session.depositChequebook(1n), { transactionHash });
    await assert.rejects(session.depositChequebook(1n));
    assert.equal(h.opens(), 1); assert.equal(h.docker.counts().posts, 1); assert.equal(h.docker.counts().networkCalls, 0);
    assert.equal(h.docker.dockerRequests.length, 6); session.dispose();
    await pause(0); assert.equal(h.docker.counts().closes, 1);
  });

  for (const value of ['', 'relative.sock', 'tcp://127.0.0.1:2375', '/tmp/with\0nul']) {
    it(`refuses invalid Unix path ${JSON.stringify(value)} before connecting`, async t => {
      const h = harness(t);
      await assert.rejects(acquireLocalDockerBeeStream(syntheticTarget, async () => ({ ...locator(), socketPath: value }), limits, qualified, undefined, h.connect));
      assert.equal(h.opens(), 0);
    });
  }
  for (const change of [{ alias: 'another' }, { kind: 'ssh-unix' }, { socketPath: null }, { alias: '' }]) {
    it(`refuses a mismatched or malformed locator ${JSON.stringify(change)}`, async t => {
      const h = harness(t);
      await assert.rejects(acquireLocalDockerBeeStream(syntheticTarget, async () => Object.assign(locator(), change), limits, qualified, undefined, h.connect));
      assert.equal(h.opens(), 0);
    });
  }
  for (const invalid of [null, { acquisitionTimeoutMs: 0 }, { acquisitionTimeoutMs: 30001 }, { cleanupGraceMs: NaN }]) {
    it(`refuses invalid options before invoking the resolver ${JSON.stringify(invalid)}`, async t => {
      const h = harness(t); let resolutions = 0;
      // @ts-expect-error Deliberately malformed runtime options.
      await assert.rejects(acquireLocalDockerBeeStream(syntheticTarget, async () => { resolutions++; return locator(); }, invalid, qualified, undefined, h.connect));
      assert.equal(resolutions, 0); assert.equal(h.opens(), 0);
    });
  }

  it('captures proof, alias, options and returned locator before delayed mutation', async t => {
    const h = harness(t); const proof = structuredClone(syntheticTarget); const options = { ...limits }; const found = locator();
    let resolve!: (value: LocalDockerLocator) => void;
    const pending = acquireLocalDockerBeeStream(proof, () => new Promise(done => { resolve = done; }), options, qualified, undefined, h.connect);
    Object.assign(proof, { alias: 'other', daemonId: 'other' }); options.acquisitionTimeoutMs = 1;
    h.onReady(async () => { Object.assign(found, { alias: 'other', socketPath: '/other.sock' }); });
    resolve(found);
    const result = await pending; result.stream.destroy();
    assert.equal(h.opens(), 1); assert.equal(result.binding.daemonId, syntheticTarget.daemonId);
  });

  it('does not connect after a resolver synchronously exceeds the original acquisition deadline', async t => {
    const h = harness(t);
    await assert.rejects(acquireLocalDockerBeeStream(syntheticTarget, async () => { block(35); return locator(); }, { ...limits, acquisitionTimeoutMs: 20 }, qualified, undefined, h.connect));
    assert.equal(h.opens(), 0);
  });

  it('settles a hung resolver at the bound and ignores its late success', async t => {
    const h = harness(t); let release!: (value: LocalDockerLocator) => void;
    const pending = acquireLocalDockerBeeStream(syntheticTarget, () => new Promise(resolve => { release = resolve; }), { ...limits, acquisitionTimeoutMs: 20 }, qualified, undefined, h.connect);
    await assert.rejects(pending); release(locator()); await pause(0); assert.equal(h.opens(), 0);
  });

  it('destroys immediately owned connection when readiness resolves after timeout without making HTTP requests', async t => {
    const h = harness(t); let release!: () => void;
    h.onReady(() => new Promise(resolve => { release = resolve; }));
    await assert.rejects(acquireLocalDockerBeeStream(syntheticTarget, async () => locator(), { ...limits, acquisitionTimeoutMs: 20 }, qualified, undefined, h.connect));
    assert.equal(h.docker.transport.destroyed, true); release(); await pause(0);
    assert.equal(h.docker.dockerRequests.length, 0); assert.equal(h.opens(), 1); assert.equal(h.docker.counts().closes, 1);
  });

  it('destroys a socket returned after a synchronous connector overrun without handshaking', async t => {
    const h = harness(t);
    await assert.rejects(acquireLocalDockerBeeStream(syntheticTarget, async () => locator(), { ...limits, acquisitionTimeoutMs: 20 }, qualified, undefined, path => {
      const connection = h.connect(path); block(35); return connection;
    }));
    assert.equal(h.docker.transport.destroyed, true); assert.equal(h.docker.dockerRequests.length, 0);
  });

  it('does not reset the acquisition allowance after resolution and connection', async t => {
    const h = harness(t);
    h.onReady(async () => { await pause(90); });
    h.docker.peer.pause();
    const started = performance.now();
    await assert.rejects(acquireLocalDockerBeeStream(syntheticTarget, async () => { await pause(90); return locator(); }, { ...limits, acquisitionTimeoutMs: 240 }, qualified, undefined, h.connect));
    assert.ok(performance.now() - started < 380, 'A fresh handshake budget would permit about420ms');
    assert.equal(h.docker.transport.destroyed, true); assert.equal(h.opens(), 1);
  });

  for (const phase of ['before', 'resolve', 'connect', 'handshake', 'handoff'] as const) {
    it(`honors cancellation ${phase} with one disposal and no replacement`, async t => {
      const h = harness(t); const controller = new AbortController();
      if (phase === 'before') controller.abort();
      if (phase === 'connect') h.onReady(async () => { controller.abort(); });
      if (phase === 'handshake') h.docker.peer.pause();
      const pending = acquireLocalDockerBeeStream(syntheticTarget, async () => {
        if (phase === 'resolve') controller.abort(); return locator();
      }, limits, qualified, controller.signal, h.connect);
      if (phase === 'handshake') { await pause(5); controller.abort(); }
      if (phase === 'handoff') {
        const acquired = await pending; controller.abort(); await pause(0);
        assert.equal(acquired.stream.destroyed, true);
      } else await assert.rejects(pending);
      controller.abort(); await pause(0);
      assert.equal(h.opens(), phase === 'before' || phase === 'resolve' ? 0 : 1);
      assert.equal(h.docker.dockerRequests.some(request => request.url.endsWith('/exec')), phase === 'handoff');
      assert.ok(h.docker.counts().closes <= 1);
    });
  }

  it('keeps the original total deadline after a slow locator instead of extending the transferred stream', async t => {
    const h = harness(t); const started = performance.now();
    const result = await acquireLocalDockerBeeStream(syntheticTarget, async () => { await pause(120); return locator(); },
      { acquisitionTimeoutMs: 250, preflightTimeoutMs: 20, postTimeoutMs: 20, cleanupGraceMs: 10 }, qualified, undefined, h.connect);
    await new Promise<void>(resolve => result.stream.once('close', resolve));
    assert.ok(performance.now() - started < 400, 'Resetting the total allowance after resolution would permit420ms');
    assert.equal(h.docker.transport.destroyed, true);
  });

  it('defaults to qualification refusal and never sends an exec POST', async t => {
    const h = harness(t);
    await assert.rejects(acquireLocalDockerBeeStream(syntheticTarget, async () => locator(), limits, undefined, undefined, h.connect));
    assert.equal(h.docker.dockerRequests.length, 4); assert.equal(h.docker.transport.destroyed, true);
  });

  for (const phase of ['resolver', 'constructor', 'readiness', 'closed', 'late-error'] as const) {
    it(`contains ${phase} failure without exposing upstream diagnostics or retrying`, async t => {
      const h = harness(t); const sensitive = new Error('synthetic-sensitive-diagnostic');
      if (phase === 'readiness') h.onReady(async () => { throw sensitive; });
      if (phase === 'closed') h.docker.transport.destroy();
      const pending = acquireLocalDockerBeeStream(syntheticTarget, async () => {
        if (phase === 'resolver') throw sensitive; return locator();
      }, limits, qualified, undefined, path => {
        if (phase === 'constructor') throw sensitive;
        const value = h.connect(path);
        if (phase === 'late-error') queueMicrotask(() => value.stream.destroy(sensitive));
        return value;
      });
      await assert.rejects(pending, error => error instanceof Error && !JSON.stringify({ message: error.message, cause: error.cause }).includes('synthetic-sensitive'));
      h.docker.transport.emit('error', sensitive); assert.ok(h.opens() <= 1);
    });
  }

  it('disposes the native socket if listener setup throws after creation', () => {
    const socket = new PassThrough(); let destroys = 0;
    const destroy = socket.destroy.bind(socket); socket.destroy = error => { destroys++; return destroy(error); };
    socket.once = () => { throw new Error('synthetic-sensitive-setup'); };
    assert.throws(() => openUnixDockerConnection('/synthetic/only.sock', () => socket), error => error instanceof Error && !error.message.includes('synthetic-sensitive'));
    assert.equal(destroys, 1); assert.equal(socket.destroyed, true);
  });

  for (const event of ['connect', 'error', 'close'] as const) {
    it(`observes native readiness ${event} without leaving readiness listeners or exposing diagnostics`, async t => {
      const socket = new PassThrough(); t.after(() => socket.destroy());
      const connection = openUnixDockerConnection('/synthetic/only.sock', options => {
        assert.deepEqual(options, { path: '/synthetic/only.sock' }); return socket;
      });
      const checked = event === 'connect' ? connection.connected : assert.rejects(connection.connected,
        error => error instanceof Error && !error.message.includes('synthetic-sensitive'));
      socket.emit(event, new Error('synthetic-sensitive-native')); await checked;
      assert.equal(socket.listenerCount('connect'), 0); assert.equal(socket.listenerCount('close'), 0);
      socket.emit('error', new Error('synthetic-sensitive-late')); socket.destroy();
    });
  }
});
