import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { ChequebookTransferPreparation, type OwnedTransferPreparationOptions } from '../../src/domain/chequebook/ChequebookTransferPreparation.js';
import { acquireDockerBeeStream, type AcquiredDockerBeeStream } from '../../src/domain/chequebook/acquireDockerBeeStream.js';
import { ChequebookChainRegistry } from '../../src/domain/chequebook/ChequebookChainRegistry.js';
import { ChequebookSubmission } from '../../src/domain/chequebook/ChequebookSubmission.js';
import type { FrozenChequebookTarget } from '../../src/domain/chequebook/FrozenChequebookTarget.js';
import { InMemoryChequebookOperations, transferContext, transferIntent } from '../support/chequebookOperations.js';
import { syntheticDockerBee, syntheticImageId, syntheticTarget, type SyntheticBeeHandler } from '../support/syntheticDockerBee.js';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function harness(t: TestContext, options: OwnedTransferPreparationOptions = {}, intercept?: SyntheticBeeHandler) {
  const docker = syntheticDockerBee(t, intercept);
  const target = structuredClone(syntheticTarget);
  const signals: AbortSignal[] = [];
  const seenProofs: FrozenChequebookTarget[] = [];
  const seenBudgets: Readonly<OwnedTransferPreparationOptions>[] = [];
  let captures = 0; let acquisitions = 0;
  let ignoreLifetime = false;
  let acquiredHook: ((value: AcquiredDockerBeeStream) => Promise<AcquiredDockerBeeStream>) | undefined;
  let captureHook: (() => Promise<void>) | undefined;
  const reader = {
    async chainId() { return 100; }, async transactionCount() { return '8'; },
    async transaction() { return null; }, async receipt() { return null; }, async blockTransactions() { return null; },
    async blockHeader() { return { number: '500', hash: transferContext.startBlockHash, parentHash: `0x${'55'.repeat(32)}` }; },
  };
  const preparation = ChequebookTransferPreparation.fromOwnedTarget(async (name, instance) => {
    assert.equal(name, syntheticTarget.profile.name); assert.equal(instance, syntheticTarget.profile.instanceId);
    captures++; await captureHook?.(); return target;
  }, async (proof, budgets, signal) => {
    acquisitions++; signals.push(signal); seenProofs.push(proof); seenBudgets.push(budgets);
    const acquired = await acquireDockerBeeStream(docker.transport, proof, budgets, image => image === syntheticImageId, ignoreLifetime ? undefined : signal);
    return acquiredHook ? acquiredHook(acquired) : acquired;
  }, new ChequebookChainRegistry('{"100":"https://rpc.example.invalid"}', () => reader), options);
  const repository = new InMemoryChequebookOperations();
  const submission = new ChequebookSubmission(repository, input => preparation.prepare(input));
  return { docker, target, preparation, repository, submission, signals, seenProofs, seenBudgets, reader, counts: () => ({ captures, acquisitions }),
    onAcquired(hook: typeof acquiredHook) { acquiredHook = hook; }, onCapture(hook: typeof captureHook) { captureHook = hook; },
    ignoreAcquisitionCancellation() { ignoreLifetime = true; } };
}

describe('owned Docker/Bee transfer preparation composition', { timeout: 5000 }, () => {
  it('keeps the successful preparation lease alive until explicitly disposed', async t => {
    const h = harness(t);
    const prepared = await h.preparation.prepare(transferIntent());
    assert.equal(h.signals[0]!.aborted, false);
    assert.equal(h.docker.transport.destroyed, false);
    prepared.dispose();
    assert.equal(h.signals[0]!.aborted, true);
    assert.equal(h.docker.counts().posts, 0);
  });

  for (const direction of ['deposit', 'withdraw'] as const) {
    it(`submits ${direction} once on the original framed connection and journals the immutable target`, async t => {
      const h = harness(t);
      let journalProof: FrozenChequebookTarget | undefined;
      const admit = h.repository.admit.bind(h.repository);
      h.repository.admit = async candidate => { journalProof = candidate.submissionTarget; return admit(candidate); };
      const result = await h.submission.submit(transferIntent({ direction }));
      assert.equal(result.operation.state, 'submitted');
      assert.deepEqual(journalProof, syntheticTarget);
      assert.ok(Object.isFrozen(journalProof) && Object.isFrozen(journalProof!.profile) && Object.isFrozen(journalProof!.reservation));
      assert.equal(h.docker.counts().posts, 1); assert.equal(h.counts().acquisitions, 1); assert.equal(h.docker.counts().networkCalls, 0);
      assert.equal(h.docker.dockerRequests.length, 5);
      assert.ok(h.docker.beeRequests.filter(request => request.url === '/addresses').length >= 2);
      assert.equal(h.docker.beeRequests.at(-1)!.url, `/chequebook/${direction}?amount=5000000000000000`);
      assert.equal(h.signals[0]!.aborted, true);
      assert.equal(h.docker.transport.destroyed, true);
    });
  }

  it('freezes capture before acquisition and keeps the public proof immutable without altering its baseline', async t => {
    const h = harness(t);
    h.onAcquired(async value => { Object.assign(h.target.reservation, { port: 9999 }); return value; });
    const intent = transferIntent();
    const prepared = await h.preparation.prepare(intent);
    t.after(() => prepared.dispose());
    assert.equal(h.seenProofs[0]!.reservation.port, 11633);
    assert.ok(Object.isFrozen(h.seenProofs[0]));
    assert.throws(() => { Object.assign(prepared.submissionTarget!.profile, { name: 'another' }); }, TypeError);
    assert.throws(() => { prepared.submissionTarget = structuredClone(h.target); }, TypeError);
    const result = await new ChequebookSubmission(h.repository, async () => prepared).submit(intent);
    assert.equal(result.operation.state, 'rejected'); assert.equal(h.docker.counts().posts, 0);
  });

  for (const change of ['name', 'instance'] as const) {
    it(`refuses a captured ${change} that differs from the requested profile before acquisition`, async t => {
      const h = harness(t);
      Object.assign(h.target.profile, change === 'name' ? { name: 'another' } : { instanceId: '22222222-2222-4222-8222-222222222222' });
      await assert.rejects(h.preparation.prepare(transferIntent()));
      assert.equal(h.counts().acquisitions, 0); assert.equal(h.docker.counts().posts, 0); assert.equal(h.docker.counts().networkCalls, 0);
    });
  }

  for (const change of ['instance', 'reservation', 'alias-epoch', 'daemon', 'intent'] as const) {
    it(`refuses a changed ${change} during preflight without a second connection`, async t => {
      const h = harness(t);
      const submit = new ChequebookSubmission(h.repository, async intent => {
        const prepared = await h.preparation.prepare(intent);
        if (change === 'instance') Object.assign(h.target.profile, { instanceId: '22222222-2222-4222-8222-222222222222' });
        if (change === 'reservation') Object.assign(h.target.reservation, { id: 2 });
        if (change === 'alias-epoch') Object.assign(h.target, { verifiedAt: '2026-09-09T00:00:00.000002Z' });
        if (change === 'daemon') Object.assign(h.target, { daemonId: 'another' });
        if (change === 'intent') Object.assign(h.target.profile, { intentRevision: 2 });
        return prepared;
      });
      const result = await submit.submit(transferIntent());
      assert.equal(result.operation.state, 'rejected'); assert.equal(result.operation.dispatchStartedAt, null);
      assert.equal(h.docker.counts().posts, 0); assert.equal(h.counts().acquisitions, 1); assert.equal(h.docker.counts().networkCalls, 0);
      assert.equal(h.docker.transport.destroyed, true); assert.equal(h.signals[0]!.aborted, true);
    });
  }

  for (const change of ['daemon', 'project', 'port'] as const) {
    it(`refuses contradictory selected ${change} evidence and disposes before any Bee GET`, async t => {
      const h = harness(t);
      h.onAcquired(async value => ({ ...value, binding: { ...value.binding,
        ...(change === 'daemon' ? { daemonId: 'other' } : change === 'project' ? { project: 'other' } : { publishedBindings: [{ hostIp: '0.0.0.0', hostPort: 9999 }] }) } }));
      await assert.rejects(h.preparation.prepare(transferIntent()), /checked/i);
      assert.equal(h.docker.beeRequests.length, 0); assert.equal(h.docker.transport.destroyed, true); assert.equal(h.counts().acquisitions, 1);
    });
  }

  it('disposes a late acquired stream even when the adapter ignores lifetime cancellation', async t => {
    const h = harness(t, { timeoutMs: 200 });
    h.ignoreAcquisitionCancellation();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let late: AcquiredDockerBeeStream | undefined;
    h.onAcquired(async value => { late = value; await gate; return value; });
    await assert.rejects(h.preparation.prepare(transferIntent()), /checked/i);
    assert.ok(late); assert.equal(h.signals[0]!.aborted, true); assert.equal(late.stream.destroyed, false);
    release(); await pause(0); await pause(0);
    assert.equal(late.stream.destroyed, true); assert.equal(h.docker.beeRequests.length, 0);
    assert.equal(h.docker.transport.destroyed, true); assert.equal(h.counts().acquisitions, 1);
  });

  it('never acquires after a delayed capture resolves beyond preparation timeout', async t => {
    const h = harness(t, { timeoutMs: 20 });
    let release!: () => void; h.onCapture(() => new Promise<void>(resolve => { release = resolve; }));
    await assert.rejects(h.preparation.prepare(transferIntent()), /checked/i);
    release(); await pause(0);
    assert.equal(h.counts().acquisitions, 0); assert.equal(h.docker.beeRequests.length, 0);
  });

  it('does not POST after an authoritative dispatch claim refuses ownership', async t => {
    const h = harness(t);
    h.repository.claimDispatch = async id => ({ claimed: false, operation: (await h.repository.findById(id))! });
    const result = await h.submission.submit(transferIntent());
    assert.equal(result.operation.dispatchStartedAt, null); assert.equal(h.docker.counts().posts, 0);
    assert.equal(h.docker.transport.destroyed, true); assert.equal(h.counts().acquisitions, 1);
  });

  for (const cause of ['close', 'expiry'] as const) {
    it(`keeps dispatch unknown after ${cause} during claim without acquiring a replacement`, async t => {
      const h = harness(t, cause === 'expiry' ? { preflightTimeoutMs: 200 } : {});
      const claim = h.repository.claimDispatch.bind(h.repository);
      h.repository.claimDispatch = async id => {
        const result = await claim(id);
        if (cause === 'close') h.docker.peer.destroy(); else await pause(250);
        return result;
      };
      const result = await h.submission.submit(transferIntent());
      assert.equal(result.operation.state, 'unknown'); assert.ok(result.operation.dispatchStartedAt);
      assert.equal(h.docker.counts().posts, 0); assert.equal(h.counts().acquisitions, 1); assert.equal(h.docker.counts().networkCalls, 0);
    });
  }

  it('keeps a lost Bee POST response unknown and exact replay does not acquire or resend', async t => {
    const h = harness(t, {}, (request) => { if (request.method !== 'POST') return false; request.socket.destroy(); return true; });
    const intent = transferIntent();
    assert.equal((await h.submission.submit(intent)).operation.state, 'unknown');
    assert.equal((await h.submission.submit(intent)).kind, 'replayed');
    assert.equal(h.docker.counts().posts, 1); assert.equal(h.counts().acquisitions, 1);
    assert.equal(h.docker.counts().networkCalls, 0); assert.equal(h.docker.transport.destroyed, true);
  });

  it('clones one validated configuration before any acquisition and forwards the same session budgets', async t => {
    const options = { preflightTimeoutMs: 1234, postTimeoutMs: 4321, acquisitionTimeoutMs: 2000, cleanupGraceMs: 20 };
    const h = harness(t, options);
    Object.assign(options, { preflightTimeoutMs: 1, postTimeoutMs: 1 });
    const prepared = await h.preparation.prepare(transferIntent()); t.after(() => prepared.dispose());
    assert.equal(h.seenBudgets[0]!.preflightTimeoutMs, 1234); assert.equal(h.seenBudgets[0]!.postTimeoutMs, 4321);
    assert.ok(Object.isFrozen(h.seenBudgets[0]));
    assert.equal(h.docker.transport.destroyed, false);
  });

  it('uses the same configured POST deadline in the framed Bee session and Docker acquisition budget', async t => {
    const h = harness(t, { postTimeoutMs: 20 }, request => request.method === 'POST');
    const result = await h.submission.submit(transferIntent());
    assert.equal(result.operation.state, 'unknown');
    assert.equal(h.seenBudgets[0]!.postTimeoutMs, 20);
    assert.equal(h.docker.counts().posts, 1); assert.equal(h.counts().acquisitions, 1);
    assert.equal(h.docker.transport.destroyed, true);
  });

  it('bounds a held framed identity response and aborts the owned lifetime', async t => {
    const h = harness(t, { readTimeoutMs: 20 }, request => request.url === '/addresses');
    await assert.rejects(h.preparation.prepare(transferIntent()), /checked/i);
    assert.equal(h.signals[0]!.aborted, true); assert.equal(h.docker.transport.destroyed, true);
    assert.equal(h.docker.counts().posts, 0); assert.equal(h.counts().acquisitions, 1);
  });

  for (const cause of ['busy', 'journal'] as const) {
    it(`disposes without POST when admission returns ${cause}`, async t => {
      const h = harness(t);
      if (cause === 'busy') await h.repository.admit({ id: crypto.randomUUID(), ...transferIntent(), ...transferContext });
      else h.repository.admit = async () => { throw new Error('sensitive synthetic journal diagnostic'); };
      if (cause === 'busy') assert.equal((await h.submission.submit(transferIntent())).kind, 'busy');
      else await assert.rejects(h.submission.submit(transferIntent()), error => error instanceof Error && !error.message.includes('sensitive'));
      assert.equal(h.docker.counts().posts, 0); assert.equal(h.counts().acquisitions, 1); assert.equal(h.docker.transport.destroyed, true);
    });
  }
});
