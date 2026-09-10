import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import pg from 'pg';
import { Duplex } from 'node:stream';
import { createChequebookOperationsService } from '../../src/domain/chequebook/createChequebookOperationsService.js';
import type { FrozenChequebookTarget } from '../../src/domain/chequebook/FrozenChequebookTarget.js';
import { qualifiedBridge } from '../support/qualifiedBeeBridge.js';
import { InMemoryChequebookOperations, transferContext, transferIntent, operationCandidate } from '../support/chequebookOperations.js';
import { syntheticDockerBee, syntheticTarget, type SyntheticBeeHandler } from '../support/syntheticDockerBee.js';
import { fakeForwardHarness, remoteLocator } from '../support/sshForwardLifecycle.js';
import { acquireDockerBeeStream } from '../../src/domain/chequebook/acquireDockerBeeStream.js';
import type { ChequebookChainReader } from '../../src/domain/chequebook/ChequebookChainRegistry.js';
import { ChequebookDockerTransports } from '../../src/domain/chequebook/ChequebookDockerTransports.js';
import { Logger } from '../../src/domain/Logger.js';

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

it('runtime selection cannot renew an acquisition allowance while timer callbacks are delayed', async t => {
  const h = harness(t); const select = ChequebookDockerTransports.prototype.select;
  t.mock.method(ChequebookDockerTransports.prototype, 'select', function (this: ChequebookDockerTransports, alias: string) {
    const selected = select.call(this, alias); const deadline = performance.now() + 30;
    while (performance.now() < deadline) {}
    return selected;
  });
  const service = createChequebookOperationsService(h.pool, runtime(), { ...h.dependencies,
    preparation: { ...h.dependencies.preparation, acquisitionTimeoutMs: 20 } });
  await assert.rejects(service.submit(transferIntent()));
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
  await assert.rejects(h.service.submit(transferIntent()), { name: 'ChequebookJournalError', message: 'The transfer journal could not be checked or updated. Refresh the operation before taking another action.' });
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
  const submitting = h.service.submit(transferIntent()); const refused = assert.rejects(submitting);
  while (!h.counts().connections) await pause();
  const observations = await h.service.shutdown(); await refused;
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

it('the remote factory branch uses the accepted handshake and waits for owned fake child/path cleanup', async t => {
  const h = harness(t); const remote = fakeForwardHarness();
  remote.dependencies.clock = { now: () => performance.now(), schedule(call, milliseconds) { const timer = setTimeout(call, milliseconds); return () => clearTimeout(timer); } };
  remote.dependencies.connect = () => ({ stream: h.fixture.transport, connected: Promise.resolve() });
  remote.dependencies.acquire = acquireDockerBeeStream;
  const service = createChequebookOperationsService(h.pool, { ...runtime(), dockerTransports: JSON.stringify({
    [syntheticTarget.alias]: { locator: remoteLocator(), qualificationIds: ['synthetic-only'] },
  }) }, { ...h.dependencies, ssh: remote.dependencies });
  t.after(() => service.shutdown());
  const result = await service.submit(transferIntent());
  assert.equal(result.operation.state, 'submitted'); assert.equal(h.fixture.counts().posts, 1);
  assert.ok((await service.shutdown()).every(value => value.state === 'closed'));
  assert.equal(remote.events.filter(value => value === 'spawn').length, 1);
  assert.equal(remote.events.filter(value => value === 'unlink').length, 1);
  assert.equal(remote.events.filter(value => value === 'rmdir').length, 1);
  assert.equal(remote.paths.size, 0); assert.deepEqual(remote.child.signals, ['SIGTERM']);
  assert.equal(h.counts().connections, 0); assert.equal(h.fixture.counts().networkCalls, 0);
});

/** Keeps a test's own poller quiet without hiding what it would have said. */
const recordedLog = () => { const lines: string[] = []; return { lines, info: (line: string) => lines.push(line), warn: (line: string) => lines.push(line) }; };

/** Answers one exact transaction with a canonical finalized success receipt. */
function settlingReader(base: ChequebookChainReader, operation: { transactionHash: string | null; chainId: number; nodeAddress: string; tokenAddress: string; chequebookAddress: string; amountPlur: string; startBlockHash: string }): ChequebookChainReader {
  const hash = operation.transactionHash!;
  const hashAt = (number: bigint) => number === 500n ? operation.startBlockHash : `0x${number.toString(16).padStart(64, '0')}`;
  const transaction = { hash, chainId: operation.chainId, from: operation.nodeAddress, to: operation.tokenAddress,
    data: `0xa9059cbb${operation.chequebookAddress.slice(2).padStart(64, '0')}${BigInt(operation.amountPlur).toString(16).padStart(64, '0')}`,
    nonce: '9', value: '0', blockNumber: '501', blockHash: hashAt(501n) };
  return { ...base,
    async transaction(requested) { return requested === hash ? transaction : null; },
    async receipt(requested) { return requested === hash ? { transactionHash: hash, from: transaction.from, to: transaction.to, blockNumber: '501', blockHash: hashAt(501n), status: 'success' as const } : null; },
    async blockHeader(block) { const number = block === 'finalized' || block === 'latest' ? 501n : block;
      return { number: String(number), hash: hashAt(number), parentHash: hashAt(number - 1n) }; } };
}

it('the started service polls its own submitted transfer to settlement and polls nothing after shutdown', async t => {
  const h = harness(t);
  const operation = (await h.service.submit(transferIntent())).operation;
  assert.equal(operation.state, 'submitted');
  assert.ok(operation.receiptPollUntil);
  const ticks: (() => void)[] = [];
  const service = createChequebookOperationsService(h.pool, { ...runtime(), dockerTransports: undefined }, {
    ...h.dependencies, qualificationCatalog: undefined, createChainReader: () => settlingReader(h.reader, operation),
    receiptPolling: { intervalMs: 5, schedule: call => { ticks.push(call); return () => {}; }, log: recordedLog() },
  });
  t.after(() => service.shutdown());
  service.start();
  for (let round = 0; round < 40 && (await h.repository.findById(operation.id))?.state === 'submitted'; round++) await pause();
  assert.equal((await h.repository.findById(operation.id))?.state, 'settled');
  assert.equal(ticks.length, 1);
  const later = (await h.repository.admit(operationCandidate({ profileName: 'later-deployment', nodeAddress: `0x${'cc'.repeat(20)}` }))).operation;
  await h.repository.claimDispatch(later.id);
  await h.repository.recordSubmission(later.id, { state: 'submitted', transactionHash: `0x${'ee'.repeat(32)}`, failureReason: null });
  assert.ok((await h.service.shutdown()).every(value => value.state === 'closed'));
  await service.shutdown();
  ticks[0]!();
  for (let round = 0; round < 20; round++) await pause();
  assert.equal((await h.repository.findById(later.id))?.receiptCheckedAt, null);
  assert.equal(h.fixture.counts().posts, 1);
});

it('the production factory sends receipt polling notes and journal failures to the manager logger', async t => {
  const h = harness(t);
  const notes: string[] = [];
  const warnings: string[] = [];
  t.mock.method(Logger.prototype, 'info', (...args: unknown[]) => { notes.push(args.join(' ')); });
  t.mock.method(Logger.prototype, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')); });
  const operation = (await h.service.submit(transferIntent())).operation;
  const settling = createChequebookOperationsService(h.pool, { ...runtime(), dockerTransports: undefined }, {
    ...h.dependencies, qualificationCatalog: undefined, createChainReader: () => settlingReader(h.reader, operation),
    receiptPolling: { intervalMs: 5, schedule: () => () => {} },
  });
  t.after(() => settling.shutdown());
  settling.start();
  for (let round = 0; round < 40 && notes.length === 0; round++) await pause();
  assert.equal(notes.length, 1, 'the production default is not the no-op logger');
  assert.match(notes[0]!, new RegExp(`${operation.id} settled`));
  assert.deepEqual(warnings, []);
  await settling.shutdown();

  const unreadable = new InMemoryChequebookOperations();
  unreadable.listAwaitingReceipt = async () => { throw new Error('synthetic-journal-failure'); };
  const failing = createChequebookOperationsService(h.pool, runtime(), { ...h.dependencies, repository: unreadable,
    receiptPolling: { intervalMs: 5, schedule: () => () => {} } });
  t.after(() => failing.shutdown());
  failing.start();
  for (let round = 0; round < 40 && warnings.length === 0; round++) await pause();
  assert.deepEqual(warnings, ['Receipt polling could not read the transfer journal.']);
  assert.equal(notes.length, 1, 'a journal that cannot be read is a warning and not a note');
});

it('shutdown while target capture is held refuses later acquisition', async t => {
  const h = harness(t); let release!: () => void; let started = false;
  const service = createChequebookOperationsService(h.pool, runtime(), { ...h.dependencies,
    captureTarget: async () => { started = true; await new Promise<void>(resolve => { release = resolve; }); return syntheticTarget; } });
  const submitting = service.submit(transferIntent()); const refused = assert.rejects(submitting);
  while (!started) await pause();
  assert.deepEqual(await service.shutdown(), []); release(); await refused;
  assert.equal(h.counts().connections, 0); assert.equal(h.repository.rows.size, 0);
});

it('shutdown during a held journal claim cannot revive the disposed session for POST', async t => {
  const h = harness(t); let release!: () => void; let claiming = false;
  const claim = h.repository.claimDispatch.bind(h.repository);
  h.repository.claimDispatch = async id => { claiming = true; await new Promise<void>(resolve => { release = resolve; }); return claim(id); };
  const submitting = h.service.submit(transferIntent()); while (!claiming) await pause();
  assert.ok((await h.service.shutdown()).every(value => value.state === 'closed'));
  release(); const result = await submitting;
  assert.equal(result.operation.state, 'unknown'); assert.equal(h.fixture.counts().posts, 0); assert.equal(h.counts().connections, 1);
});

it('remote cleanup without confirmed child exit remains visible after later resource cleanup', async t => {
  const h = harness(t); const remote = fakeForwardHarness(); remote.child.exitOn = null;
  remote.dependencies.clock = { now: () => performance.now(), schedule(call, milliseconds) { const timer = setTimeout(call, milliseconds); return () => clearTimeout(timer); } };
  remote.dependencies.connect = () => ({ stream: h.fixture.transport, connected: Promise.resolve() });
  remote.dependencies.acquire = acquireDockerBeeStream;
  const service = createChequebookOperationsService(h.pool, { ...runtime(), dockerTransports: JSON.stringify({
    [syntheticTarget.alias]: { locator: remoteLocator(), qualificationIds: ['synthetic-only'] },
  }) }, { ...h.dependencies, ssh: remote.dependencies });
  t.after(() => { remote.child.emit('exited'); return service.shutdown(); });
  await service.submit(transferIntent());
  const observations = await service.shutdown();
  assert.equal(observations.length, 1); const outcome = observations[0]!;
  assert.equal(outcome.state, 'unverified'); if (outcome.state === 'unverified') assert.ok(outcome.remaining.includes('child'));
  assert.deepEqual(remote.child.signals, ['SIGTERM', 'SIGKILL']); assert.equal(remote.events.includes('unlink'), false);
  remote.child.emit('exited'); await pause(); assert.equal(remote.paths.size, 0);
  assert.deepEqual(await service.shutdown(), observations);
});

it('receipt recovery after profile deletion uses the frozen transaction and needs no transport qualification', async t => {
  const h = harness(t); const initial = await h.service.submit(transferIntent()); h.deleted();
  const operation = initial.operation; const hash = operation.transactionHash!;
  const hashAt = (number: bigint) => number === 500n ? operation.startBlockHash : `0x${number.toString(16).padStart(64, '0')}`;
  const minedHash = hashAt(501n);
  const transaction = { hash, chainId: operation.chainId, from: operation.nodeAddress, to: operation.tokenAddress,
    data: `0xa9059cbb${operation.chequebookAddress.slice(2).padStart(64, '0')}${BigInt(operation.amountPlur).toString(16).padStart(64, '0')}`,
    nonce: '9', value: '0', blockNumber: '501', blockHash: minedHash };
  const reader: ChequebookChainReader = { ...h.reader, async transaction() { return transaction; }, async receipt() {
    return { transactionHash: hash, from: transaction.from, to: transaction.to, blockNumber: '501', blockHash: minedHash, status: 'success' }; },
    async blockHeader(block) { const number = block === 'finalized' || block === 'latest' ? 501n : block;
      return { number: String(number), hash: hashAt(number), parentHash: hashAt(number - 1n) }; } };
  const service = createChequebookOperationsService(h.pool, { ...runtime(), dockerTransports: undefined }, {
    ...h.dependencies, qualificationCatalog: undefined, createChainReader: () => reader,
  });
  assert.equal((await service.check(operation.id)).operation.state, 'settled');
  assert.equal(h.counts().connections, 1); assert.equal(h.fixture.counts().posts, 1);
  await service.shutdown();
});
