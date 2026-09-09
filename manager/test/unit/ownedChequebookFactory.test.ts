import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import pg from 'pg';
import { Duplex } from 'node:stream';
import { createChequebookOperationsService } from '../../src/domain/chequebook/createChequebookOperationsService.js';
import type { FrozenChequebookTarget } from '../../src/domain/chequebook/FrozenChequebookTarget.js';
import { qualifiedBridge } from '../support/qualifiedBeeBridge.js';
import { InMemoryChequebookOperations, transferContext, transferIntent, operationCandidate } from '../support/chequebookOperations.js';
import { syntheticDockerBee, syntheticTarget, type SyntheticBeeHandler } from '../support/syntheticDockerBee.js';

const runtime = () => ({ rpcEndpoints: '{"100":"https://rpc.example.invalid"}', dockerTransports: JSON.stringify({
  [syntheticTarget.alias]: { locator: { kind: 'unix', alias: syntheticTarget.alias, socketPath: '/synthetic/docker.sock' }, qualificationIds: ['synthetic-only'] },
}) });
const pause = () => new Promise<void>(resolve => setImmediate(resolve));
function harness(t: TestContext, intercept?: SyntheticBeeHandler) {
  const pool = new pg.Pool({ connectionString: 'postgres://unused' }); t.after(() => pool.end());
  const fixture = syntheticDockerBee(t, intercept); const repository = new InMemoryChequebookOperations();
  const target = structuredClone(syntheticTarget);
  let captures = 0; let connections = 0; let allowCapture = true;
  let captureHook: (() => void) | undefined;
  let connect = () => ({ stream: fixture.transport, connected: Promise.resolve() });
  const reader = { async chainId() { return 100; }, async transactionCount() { return '8'; }, async transaction() { return null; },
    async receipt() { return null; }, async blockTransactions() { return null; },
    async blockHeader() { return { number: '500', hash: transferContext.startBlockHash, parentHash: `0x${'55'.repeat(32)}` }; } };
  const dependencies = { repository, qualificationCatalog: [qualifiedBridge()],
    captureTarget: async () => { captures++; if (!allowCapture) throw new Error('private-synthetic-profile-diagnostic'); captureHook?.(); return target; },
    createChainReader: () => reader, connectUnix: () => { connections++; return connect(); },
    preparation: { cleanupGraceMs: 20, timeoutMs: 3000 },
  };
  const service = createChequebookOperationsService(pool, runtime(), dependencies);
  t.after(() => service.shutdown());
  return { service, dependencies, pool, repository, fixture, target, reader, counts: () => ({ captures, connections }),
    deleted() { allowCapture = false; }, onCapture(hook: () => void) { captureHook = hook; },
    setConnection(next: typeof connect) { connect = next; } };
}

it('the production factory composes one qualified owned session and the frozen SQL target into submission', async t => {
  const h = harness(t); let recorded: FrozenChequebookTarget | undefined;
  const admit = h.repository.admit.bind(h.repository); h.repository.admit = async candidate => { recorded = candidate.submissionTarget; return admit(candidate); };
  const result = await h.service.submit(transferIntent());
  assert.equal(result.kind, 'admitted'); assert.equal(result.operation.state, 'submitted');
  assert.deepEqual(recorded, syntheticTarget); assert.equal(h.counts().connections, 1);
  assert.equal(h.fixture.counts().posts, 1); assert.equal(h.fixture.counts().networkCalls, 0);
  assert.equal(h.fixture.dockerRequests.length, 6); assert.equal(h.fixture.transport.destroyed, true);
  assert.ok((await h.service.shutdown()).every(value => value.state === 'closed'));
});

it('history and exact replay survive deleted profiles and missing or malformed runtime routing', async t => {
  const h = harness(t); const intent = transferIntent(); const initial = await h.service.submit(intent); h.deleted();
  for (const invalid of [undefined, '{broken']) {
    const service = createChequebookOperationsService(h.pool, { rpcEndpoints: invalid, dockerTransports: invalid }, h.dependencies);
    assert.equal((await service.byRequestId(intent.requestId)).operation.id, initial.operation.id);
    assert.equal((await service.history({ limit: 5 })).operations.length, 1);
    assert.equal((await service.submit(intent)).kind, 'replayed'); await service.shutdown();
  }
  assert.equal(h.fixture.counts().posts, 1); assert.equal(h.counts().connections, 1);
});

it('an empty production qualification catalog refuses before any transport construction', async t => {
  const h = harness(t);
  const service = createChequebookOperationsService(h.pool, runtime(), { ...h.dependencies, qualificationCatalog: undefined });
  await assert.rejects(service.submit(transferIntent()), { name: 'ChequebookPreparationError' });
  assert.equal(h.counts().connections, 0); assert.equal(h.repository.rows.size, 0); await service.shutdown();
});

it('a changed captured target at preflight refuses the single dispatch without another connection', async t => {
  const h = harness(t); let captures = 0;
  h.onCapture(() => { if (++captures === 2) Object.assign(h.target.reservation, { port: 11634 }); });
  const result = await h.service.submit(transferIntent());
  assert.equal(result.operation.state, 'rejected'); assert.equal(result.operation.failureReason, 'preflight_failed');
  assert.equal(h.fixture.counts().posts, 0); assert.equal(h.counts().connections, 1);
});

it('journal failure closes the acquired session and exposes only a fixed journal error', async t => {
  const h = harness(t); h.repository.admit = async () => { throw new Error('sensitive-synthetic-driver-error'); };
  await assert.rejects(h.service.submit(transferIntent()), { name: 'ChequebookJournalError', message: 'Could not access the transfer journal.' });
  assert.equal(h.fixture.transport.destroyed, true); assert.equal(h.fixture.counts().posts, 0);
});

it('a lost POST response stays unknown and exact replay never sends another transfer', async t => {
  const h = harness(t, (request) => { if (request.method !== 'POST') return false; request.socket.destroy(); return true; });
  const intent = transferIntent(); const result = await h.service.submit(intent);
  assert.equal(result.operation.state, 'unknown'); assert.equal(result.operation.failureReason, 'response_unavailable');
  assert.equal((await h.service.submit(intent)).kind, 'replayed'); assert.equal(h.fixture.counts().posts, 1); assert.equal(h.counts().connections, 1);
});

it('shutdown disposes a held POST and retains cleanup before waiting for the request', async t => {
  let posted = false;
  const h = harness(t, request => { if (request.method !== 'POST') return false; posted = true; return true; });
  const submitting = h.service.submit(transferIntent()); while (!posted) await pause();
  const cleanup = h.service.shutdown();
  const result = await submitting;
  assert.equal(result.operation.state, 'unknown'); assert.equal(h.fixture.counts().posts, 1);
  assert.ok((await cleanup).every(value => value.state === 'closed'));
  await assert.rejects(h.service.submit(transferIntent())); assert.equal(h.counts().connections, 1);
});

it('shutdown owns a pending connection before its readiness resolves', async t => {
  const h = harness(t); h.setConnection(() => ({ stream: h.fixture.transport, connected: new Promise(() => {}) }));
  const submitting = h.service.submit(transferIntent()); while (!h.counts().connections) await pause();
  const cleanup = h.service.shutdown(); await assert.rejects(submitting);
  assert.ok((await cleanup).every(value => value.state === 'closed')); assert.equal(h.fixture.transport.destroyed, true);
  assert.equal(h.fixture.dockerRequests.length, 0); assert.equal(h.fixture.counts().posts, 0);
});

it('unconfirmed local close stays unverified and no later shutdown silently changes its observation', async t => {
  const h = harness(t); let finishDestroy: (() => void) | undefined;
  const raw = new Duplex({ read() {}, write(_data, _encoding, done) { done(); }, destroy(_error, done) { finishDestroy = () => done(); } });
  raw.on('error', () => {}); t.after(() => finishDestroy?.());
  h.setConnection(() => ({ stream: raw, connected: new Promise(() => {}) }));
  const submitting = h.service.submit(transferIntent()); while (!h.counts().connections) await pause();
  const observations = await h.service.shutdown(); await assert.rejects(submitting);
  assert.equal(observations.length, 1); assert.equal(observations[0]!.state, 'unverified');
  assert.ok(!JSON.stringify(observations).includes('/synthetic'));
  finishDestroy!(); await pause(); assert.deepEqual(await h.service.shutdown(), observations);
});

it('saved unknown operations can query the owned pending path without creating a transfer', async t => {
  const h = harness(t, (request, response) => { if (request.url !== '/transactions') return false; response.end('{"pendingTransactions":[]}'); return true; });
  const admitted = await h.repository.admit(operationCandidate({ tokenAddress: '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da' }));
  await h.repository.recordSubmission(admitted.operation.id, { state: 'unknown', transactionHash: null, failureReason: 'response_unavailable' });
  await h.service.check(admitted.operation.id);
  assert.ok(h.fixture.beeRequests.some(value => value.url === '/transactions'));
  assert.equal(h.fixture.counts().posts, 0); assert.equal(h.counts().connections, 1);
});
