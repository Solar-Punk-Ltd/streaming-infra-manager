import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { beginSshDockerBeeAcquisition, type ForwardPathIdentity } from '../../src/domain/chequebook/sshDockerBeeAcquisition.js';
import { acquireDockerBeeStream } from '../../src/domain/chequebook/acquireDockerBeeStream.js';
import { PinnedBeeSession } from '../../src/domain/chequebook/PinnedBeeSession.js';
import { syntheticDockerBee, syntheticImageId, syntheticTarget } from '../support/syntheticDockerBee.js';
import { transactionHash } from '../support/chequebookOperations.js';
import { deferred, directoryPath, dirIdentity, fakeForwardHarness, forwardLimits, remoteLocator, socketIdentity, socketPath, tick } from '../support/sshForwardLifecycle.js';

function start(h = fakeForwardHarness(), signal?: AbortSignal) {
  return { h, handle: beginSshDockerBeeAcquisition(syntheticTarget, async () => remoteLocator(), forwardLimits, h.dependencies, () => true, signal) };
}
const fixedFailure = (error: unknown) => { assert.equal((error as Error).name, 'DockerBeeAcquisitionError'); assert.equal((error as Error).cause, undefined); return true; };

describe('owned SSH forward lifecycle with fake resources', { timeout: 5000 }, () => {
  it('publishes one lease, then disposes raw bytes before TERM, exit and identity-checked removal', async () => {
    const { h, handle } = start(); const result = await handle.result;
    assert.equal(h.events.filter(e => e === 'connect').length, 1); assert.equal(result.stream.destroyed, false);
    handle.dispose(); handle.dispose(); assert.deepEqual(await handle.cleanup, { state: 'closed' });
    assert.ok(h.events.indexOf('raw-dispose') < h.events.indexOf('SIGTERM'));
    assert.ok(h.events.indexOf('SIGTERM') < h.events.indexOf('unlink'));
    assert.ok(h.events.indexOf('unlink') < h.events.indexOf('rmdir')); assert.equal(h.paths.size, 0);
    assert.deepEqual(h.child.signals, ['SIGTERM']); assert.equal(result.stream.destroyed, true);
  });

  it('dispose before work starts is idempotent and never resolves or creates a resource', async () => {
    const { h, handle } = start(); handle.dispose(); handle.dispose();
    await assert.rejects(handle.result, fixedFailure); assert.deepEqual(await handle.cleanup, { state: 'closed' }); assert.deepEqual(h.events, []);
  });

  it('owns the created path before a metadata failure and reports the retained directory', async () => {
    const h = fakeForwardHarness(); let metadataReads = 0;
    h.dependencies.createDirectory = async () => { h.paths.set(directoryPath, { ...dirIdentity }); return directoryPath; };
    h.dependencies.lstat = async path => { assert.equal(path, directoryPath); metadataReads++; throw new Error('private metadata diagnostic'); };
    const { handle } = start(h); await assert.rejects(handle.result, fixedFailure); await h.clock.advance(20);
    assert.ok(metadataReads > 0); assert.deepEqual(await handle.cleanup, { state: 'unverified', reason: 'cleanup_failed', remaining: ['directory'] });
    assert.equal(h.paths.has(directoryPath), true); assert.equal(h.events.includes('rmdir'), false); assert.equal(h.events.includes('spawn'), false);
  });

  it('captures directory metadata separately after creation before spawning', async () => {
    const h = fakeForwardHarness();
    h.dependencies.createDirectory = async () => { h.events.push('mkdir-path'); h.paths.set(directoryPath, { ...dirIdentity }); return directoryPath; };
    const { handle } = start(h); await handle.result;
    assert.ok(h.events.indexOf('mkdir-path') < h.events.indexOf(`stat:${directoryPath}`));
    assert.ok(h.events.indexOf(`stat:${directoryPath}`) < h.events.indexOf('spawn'));
    handle.dispose(); assert.deepEqual(await handle.cleanup, { state: 'closed' });
  });

  it('owns a directory that resolves after the cleanup deadline without relabeling the unverified snapshot', async () => {
    const h = fakeForwardHarness(); const created = deferred<string>();
    h.dependencies.createDirectory = () => created.promise;
    const { handle } = start(h); await tick(); handle.dispose(); await assert.rejects(handle.result);
    await h.clock.advance(20); const outcome = await handle.cleanup;
    assert.deepEqual(outcome, { state: 'unverified', reason: 'pending_resource', remaining: ['directory'] }); assert.ok(Object.isFrozen(outcome));
    h.paths.set(directoryPath, { ...dirIdentity }); created.resolve(directoryPath); await tick();
    assert.equal(h.paths.size, 0); assert.equal(h.events.includes('spawn'), false); assert.equal(await handle.cleanup, outcome);
    assert.equal(outcome.state, 'unverified'); assert.ok(Object.isFrozen(outcome.remaining));
  });

  it('late directory with unproven ownership is never deleted', async () => {
    const h = fakeForwardHarness(); const created = deferred<string>();
    h.dependencies.createDirectory = () => created.promise; const { handle } = start(h); await tick(); handle.dispose();
    await h.clock.advance(20); await assert.rejects(handle.result); await handle.cleanup;
    h.paths.set(directoryPath, { ...dirIdentity, uid: 456 }); created.resolve(directoryPath); await tick();
    assert.equal(h.events.includes('rmdir'), false); assert.equal(h.paths.size, 1);
  });

  for (const phase of ['resolver', 'directory', 'spawn', 'connect', 'handshake'] as const) {
    it(`checks the original monotonic deadline after ${phase} without relying on timer callbacks`, async () => {
      const h = fakeForwardHarness(); let resolver = async () => remoteLocator();
      if (phase === 'resolver') resolver = async () => { h.clock.time = 101; return remoteLocator(); };
      else {
        const original = h.dependencies[phase === 'directory' ? 'createDirectory' : phase === 'handshake' ? 'acquire' : phase];
        // Test seam delays a synchronous return or async resolution without firing timers.
        Object.assign(h.dependencies, { [phase === 'directory' ? 'createDirectory' : phase === 'handshake' ? 'acquire' : phase]: (...args: never[]) => {
          const value = (original as (...args: never[]) => unknown)(...args); h.clock.time = 101; return value;
        } });
      }
      const handle = beginSshDockerBeeAcquisition(syntheticTarget, resolver, forwardLimits, h.dependencies, () => true);
      await assert.rejects(handle.result, fixedFailure); await tick();
      if (phase === 'resolver') assert.equal(h.events.includes('mkdir'), false);
      if (phase === 'directory') assert.equal(h.events.includes('spawn'), false);
      if (phase === 'spawn') assert.equal(h.events.includes('connect'), false);
      if (phase === 'connect') assert.equal(h.events.includes('handshake'), false);
      if (phase === 'handshake') assert.equal(h.decoded.destroyed, true);
      assert.deepEqual(await handle.cleanup, { state: 'closed' });
    });
  }

  it('clones the frozen target and bounds before resolving, and does not permit resolver mutation at later stages', async () => {
    const h = fakeForwardHarness(); const target = structuredClone(syntheticTarget); const limits = { ...forwardLimits }; const locator = remoteLocator();
    const ready = deferred<typeof locator>(); const acquire = h.dependencies.acquire;
    h.dependencies.acquire = async (...args) => { assert.equal(args[1].daemonId, syntheticTarget.daemonId); assert.ok(Object.isFrozen(args[1].profile)); return acquire(...args); };
    const spawn = h.dependencies.spawn; h.dependencies.spawn = command => { assert.equal(command.target.host, 'example.invalid'); Object.assign(locator, { host: 'mutated.invalid' }); return spawn(command); };
    const handle = beginSshDockerBeeAcquisition(target, () => ready.promise, limits, h.dependencies, () => true);
    Object.assign(target.profile, { name: 'mutated' }); Object.assign(target, { daemonId: 'mutated' }); limits.acquisitionTimeoutMs = 1;
    ready.resolve(locator); await handle.result; handle.dispose(); assert.deepEqual(await handle.cleanup, { state: 'closed' });
  });

  for (const identity of [{ ...dirIdentity, kind: 'socket' }, { ...dirIdentity, mode: 0o777 }, { ...dirIdentity, uid: 456 }, { ...dirIdentity, ino: 'replacement' }]) {
    it(`refuses unsafe directory metadata ${JSON.stringify(identity)} without spawning`, async () => {
      const h = fakeForwardHarness(); let reads = 0;
      h.dependencies.lstat = async path => path === directoryPath ? (++reads === 1 ? { ...dirIdentity } : identity as ForwardPathIdentity) : null;
      const { handle } = start(h); await assert.rejects(handle.result); assert.equal(h.events.includes('spawn'), false);
      await h.clock.advance(20); assert.equal((await handle.cleanup).state, 'unverified');
    });
  }

  it('refuses a preexisting socket and never unlinks it', async () => {
    const h = fakeForwardHarness(); h.paths.set(socketPath, { ...socketIdentity });
    const { handle } = start(h); await assert.rejects(handle.result); await h.clock.advance(20);
    assert.equal(h.events.includes('spawn'), false); assert.equal(h.events.includes('unlink'), false); assert.equal((await handle.cleanup).state, 'unverified');
  });

  it('polls socket absence without opening repeated connections and refuses replacement identity during cleanup', async () => {
    const h = fakeForwardHarness(); h.dependencies.spawn = () => h.child;
    const { handle } = start(h); await tick(); assert.equal(h.events.includes('connect'), false);
    h.paths.set(socketPath, { ...socketIdentity }); await h.clock.advance(10); await handle.result;
    h.paths.set(socketPath, { ...socketIdentity, ino: 'replacement' }); handle.dispose(); await h.clock.advance(20);
    const outcome = await handle.cleanup; assert.equal(outcome.state, 'unverified'); assert.equal(h.events.includes('unlink'), false);
    assert.equal(h.events.filter(e => e === 'connect').length, 1);
  });

  it('waits for the owned child running observation even when its socket is already visible', async () => {
    const h = fakeForwardHarness(); h.child.state = 'starting'; const { handle } = start(h);
    let finished = false; void handle.result.then(() => { finished = true; }, () => { finished = true; });
    await tick(); assert.equal(finished, false); assert.equal(h.events.includes('connect'), false);
    h.child.emit('running'); await h.clock.advance(10); await handle.result;
    handle.dispose(); assert.deepEqual(await handle.cleanup, { state: 'closed' });
  });

  it('an exit after result publication destroys the returned lease without changing its settled promise', async () => {
    const { h, handle } = start();
    void handle.result.then(() => h.child.emit('exited'));
    const result = await handle.result; assert.equal(result.stream.destroyed, true);
    assert.equal(await handle.result, result); assert.deepEqual(await handle.cleanup, { state: 'closed' });
  });

  it('a failed child needs a confirmed exit before any socket or directory is removed', async () => {
    const h = fakeForwardHarness(); h.child.exitOn = null; const { handle } = start(h); await handle.result;
    h.child.emit('failed'); await h.clock.advance(20);
    assert.equal((await handle.cleanup).state, 'unverified'); assert.equal(h.events.includes('unlink'), false);
    h.child.emit('exited'); await tick(); assert.equal(h.paths.size, 0);
  });

  for (const phase of ['resolve', 'metadata', 'connect', 'handshake'] as const) {
    it(`bounds a pending ${phase}, contains its late rejection and never reconnects`, async () => {
      const h = fakeForwardHarness(); const stalled = deferred<never>();
      let resolve = async () => remoteLocator();
      if (phase === 'resolve') resolve = () => stalled.promise;
      if (phase === 'metadata') h.dependencies.lstat = () => stalled.promise;
      if (phase === 'connect') h.dependencies.connect = () => { h.events.push('connect'); return { stream: h.raw, connected: stalled.promise }; };
      if (phase === 'handshake') h.dependencies.acquire = () => { h.events.push('handshake'); return stalled.promise; };
      const handle = beginSshDockerBeeAcquisition(syntheticTarget, resolve, forwardLimits, h.dependencies, () => true);
      await tick(); await h.clock.advance(100); await assert.rejects(handle.result, fixedFailure); await h.clock.advance(20);
      const outcome = await handle.cleanup; stalled.reject(new Error('private late error')); await tick();
      assert.equal(await handle.cleanup, outcome); assert.ok(h.events.filter(e => e === 'connect').length <= 1);
      if (phase === 'metadata') assert.equal(outcome.state, 'unverified');
      if (phase === 'connect' || phase === 'handshake') assert.equal(h.raw.destroyed, true);
    });
  }

  for (const step of ['unlink', 'rmdir'] as const) {
    it(`reports a ${step} failure without claiming removal or retrying it`, async () => {
      const h = fakeForwardHarness(); let attempts = 0;
      h.dependencies[step] = async () => { attempts++; throw new Error('private filesystem error'); };
      const { handle } = start(h); await handle.result; handle.dispose(); await tick(); await h.clock.advance(20);
      const outcome = await handle.cleanup; assert.equal(outcome.state, 'unverified');
      assert.equal(outcome.reason, 'cleanup_failed'); assert.ok(outcome.remaining.includes('directory'));
      handle.dispose(); await tick(); assert.equal(attempts, 1);
    });
  }

  it('refuses an untrusted locator before creating a directory', async () => {
    const h = fakeForwardHarness(); const handle = beginSshDockerBeeAcquisition(syntheticTarget,
      async () => ({ ...remoteLocator(), alias: 'replacement' }), forwardLimits, h.dependencies);
    await assert.rejects(handle.result, fixedFailure); assert.deepEqual(await handle.cleanup, { state: 'closed' }); assert.deepEqual(h.events, []);
  });

  it('aborts before work without consulting routing or resources', async () => {
    const controller = new AbortController(); controller.abort(); const { h, handle } = start(undefined, controller.signal);
    await assert.rejects(handle.result); assert.deepEqual(await handle.cleanup, { state: 'closed' }); assert.deepEqual(h.events, []);
  });

  for (const phase of ['synchronous spawn', 'readiness', 'connection', 'handshake', 'handoff'] as const) {
    it(`retains child exit at ${phase}, rejects the unpublished result and creates no replacement`, async () => {
      const h = fakeForwardHarness();
      if (phase === 'synchronous spawn') { const spawn = h.dependencies.spawn; h.dependencies.spawn = command => { const child = spawn(command); h.child.emit('exited'); return child; }; }
      if (phase === 'readiness') { const stat = h.dependencies.lstat; h.dependencies.lstat = async path => { const value = await stat(path); if (path === socketPath && value) h.child.emit('exited'); return value; }; }
      if (phase === 'connection') { const connect = h.dependencies.connect; h.dependencies.connect = path => { const value = connect(path); h.child.emit('exited'); return value; }; }
      if (phase === 'handshake') h.dependencies.acquire = async () => { h.child.emit('exited'); throw new Error('private upstream diagnostic'); };
      if (phase === 'handoff') { const acquire = h.dependencies.acquire; h.dependencies.acquire = async (...args) => { const value = await acquire(...args); h.child.emit('exited'); return value; }; }
      const { handle } = start(h); await assert.rejects(handle.result, fixedFailure); assert.deepEqual(await handle.cleanup, { state: 'closed' });
      assert.ok(h.events.filter(e => e === 'connect').length <= 1); assert.deepEqual(h.child.signals, []);
      if (phase === 'handoff') assert.equal(h.decoded.destroyed, true);
    });
  }

  it('owns a late handshake stream after cancellation and keeps cleanup pending until that ownership is resolved', async () => {
    const h = fakeForwardHarness(); const late = deferred<Awaited<ReturnType<typeof h.dependencies.acquire>>>();
    h.dependencies.acquire = () => late.promise; const { handle } = start(h); await tick(); handle.dispose(); await assert.rejects(handle.result);
    await h.clock.advance(20); const outcome = await handle.cleanup; assert.equal(outcome.state, 'unverified');
    late.resolve({ stream: h.decoded, binding: {} as never }); await tick(); assert.equal(h.decoded.destroyed, true); assert.equal(await handle.cleanup, outcome);
  });

  it('keeps TERM and KILL bounded, then cleans files only after confirmed child exit', async () => {
    const h = fakeForwardHarness(); h.child.exitOn = 'SIGKILL'; const { handle } = start(h); await handle.result; handle.dispose();
    assert.deepEqual(h.child.signals, ['SIGTERM']); assert.equal(h.events.includes('unlink'), false);
    await h.clock.advance(9); assert.equal(h.child.signals.length, 1); await h.clock.advance(1);
    assert.deepEqual(h.child.signals, ['SIGTERM', 'SIGKILL']); assert.deepEqual(await handle.cleanup, { state: 'closed' });
  });

  it('never reports closed for an unconfirmed child and preserves the outcome after late exit', async () => {
    const h = fakeForwardHarness(); h.child.exitOn = null; const { handle } = start(h); await handle.result; handle.dispose();
    await h.clock.advance(20); const outcome = await handle.cleanup;
    assert.deepEqual(outcome, { state: 'unverified', reason: 'child_exit_unconfirmed', remaining: ['directory', 'child', 'socket'] });
    assert.equal(h.events.includes('unlink'), false); h.child.emit('exited'); await tick(); assert.equal(h.paths.size, 0);
    assert.equal(await handle.cleanup, outcome); assert.deepEqual(h.child.signals, ['SIGTERM', 'SIGKILL']);
  });

  it('retains a hung unlink past the grace bound and later removes only its owned directory', async () => {
    const h = fakeForwardHarness(); const removed = deferred<void>();
    h.dependencies.unlink = async path => { h.events.push('unlink'); await removed.promise; h.paths.delete(path); };
    const { handle } = start(h); await handle.result; handle.dispose(); await tick(); await h.clock.advance(20);
    const outcome = await handle.cleanup; assert.equal(outcome.state, 'unverified'); assert.equal(h.events.includes('rmdir'), false);
    removed.resolve(); await tick(); assert.equal(h.paths.size, 0); assert.equal(await handle.cleanup, outcome);
  });

  it('does not repeat signals or filesystem mutations under concurrent dispose, abort and late stream errors', async () => {
    const abort = new AbortController(); const { h, handle } = start(undefined, abort.signal); const result = await handle.result;
    handle.dispose(); abort.abort(); result.stream.destroy(); h.raw.emit('error', new Error('private diagnostic')); handle.dispose();
    assert.deepEqual(await handle.cleanup, { state: 'closed' }); assert.equal(h.events.filter(e => e === 'unlink').length, 1);
    assert.equal(h.events.filter(e => e === 'rmdir').length, 1); assert.deepEqual(h.child.signals, ['SIGTERM']);
  });

  it('bounds and discards stderr bytes and never surfaces their content', async () => {
    const { h, handle } = start(); await handle.result;
    h.child.stderr.write(Buffer.alloc(65537, 'x')); await tick(); assert.deepEqual(await handle.cleanup, { state: 'closed' });
    assert.equal(h.raw.destroyed, true);
  });

  for (const boundary of ['write', 'read', 'final'] as const) {
    it(`refuses lease ${boundary} after its original operational deadline while timer callbacks are delayed`, async () => {
      const { h, handle } = start(); const result = await handle.result; result.stream.on('error', () => {});
      let output = ''; h.decoded.on('data', chunk => { output += chunk.toString(); });
      await h.clock.advance(301, false);
      if (boundary === 'write') result.stream.write('must not pass');
      else if (boundary === 'final') result.stream.end();
      else { h.decoded.write('late inbound'); result.stream.read(); }
      await tick(); assert.equal(result.stream.destroyed, true); assert.equal(h.raw.destroyed, true);
      if (boundary === 'write') assert.equal(output, '');
      await handle.cleanup;
    });
  }
});

describe('in-memory SSH lifecycle composition', { timeout: 10000 }, () => {
  it('defaults to qualification refusal before an exec request', async t => {
    const h = fakeForwardHarness(); const docker = syntheticDockerBee(t);
    h.dependencies.clock = { now: () => performance.now(), schedule: (call, ms) => { const timer = setTimeout(call, ms); return () => clearTimeout(timer); } };
    h.dependencies.connect = () => ({ stream: docker.transport, connected: Promise.resolve() }); h.dependencies.acquire = acquireDockerBeeStream;
    const handle = beginSshDockerBeeAcquisition(syntheticTarget, async () => remoteLocator(),
      { acquisitionTimeoutMs: 2500, preflightTimeoutMs: 2500, postTimeoutMs: 2500, cleanupGraceMs: 100 }, h.dependencies);
    t.after(() => handle.dispose()); await assert.rejects(handle.result); assert.deepEqual(await handle.cleanup, { state: 'closed' });
    assert.equal(docker.dockerRequests.length, 3); assert.equal(docker.dockerRequests.some(request => request.method === 'POST'), false);
  });

  it('uses the actual Docker handshake and one Bee connection without any physical acquisition', async t => {
    const h = fakeForwardHarness(); const docker = syntheticDockerBee(t); const calls: string[] = [];
    h.dependencies.clock = { now: () => performance.now(), schedule: (call, ms) => { const timer = setTimeout(call, ms); return () => clearTimeout(timer); } };
    h.dependencies.connect = path => { calls.push(path); return { stream: docker.transport, connected: Promise.resolve() }; };
    h.dependencies.acquire = acquireDockerBeeStream;
    const handle = beginSshDockerBeeAcquisition(syntheticTarget, async () => remoteLocator(),
      { acquisitionTimeoutMs: 2500, preflightTimeoutMs: 2500, postTimeoutMs: 2500, cleanupGraceMs: 100 }, h.dependencies, image => image === syntheticImageId);
    t.after(() => handle.dispose()); const result = await handle.result; const session = PinnedBeeSession.fromStream(result.stream); t.after(() => session.dispose());
    await session.getAddresses(); await session.getWallet(); assert.deepEqual(await session.depositChequebook(1n), { transactionHash });
    await assert.rejects(session.depositChequebook(1n)); assert.deepEqual(calls, [socketPath]); assert.equal(docker.counts().networkCalls, 0); assert.equal(docker.counts().posts, 1);
    session.dispose(); assert.deepEqual(await handle.cleanup, { state: 'closed' });
  });

  it('child exit during a held Bee POST loses the response without reconnecting or sending again', async t => {
    const h = fakeForwardHarness(); const posted = deferred<void>();
    const docker = syntheticDockerBee(t, request => { if (request.method !== 'POST') return false; posted.resolve(); return true; });
    h.dependencies.clock = { now: () => performance.now(), schedule: (call, ms) => { const timer = setTimeout(call, ms); return () => clearTimeout(timer); } };
    h.dependencies.connect = () => ({ stream: docker.transport, connected: Promise.resolve() }); h.dependencies.acquire = acquireDockerBeeStream;
    const handle = beginSshDockerBeeAcquisition(syntheticTarget, async () => remoteLocator(),
      { acquisitionTimeoutMs: 2500, preflightTimeoutMs: 2500, postTimeoutMs: 2500, cleanupGraceMs: 100 }, h.dependencies, () => true);
    t.after(() => handle.dispose()); const result = await handle.result; const session = PinnedBeeSession.fromStream(result.stream); t.after(() => session.dispose());
    await session.getAddresses(); const sending = session.depositChequebook(1n); const refused = assert.rejects(sending);
    await posted.promise; h.child.emit('exited'); await refused; await assert.rejects(session.depositChequebook(1n));
    assert.equal(docker.counts().posts, 1); assert.equal(docker.counts().networkCalls, 0); assert.deepEqual(await handle.cleanup, { state: 'closed' });
  });
});
