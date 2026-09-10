/**
 * The whole money path, connected, with nothing real behind it.
 *
 * Every other T09 suite replaces one part: the SQL suite fakes the chain and
 * the Bee session, the factory test fakes the journal, the browser suites fake
 * the manager. This one signs in over HTTP, goes through the real router into
 * a real PostgreSQL journal, over the owned Docker transport to a synthetic
 * Bee, and reads the outcome back out. What is synthetic is the Bee, the chain
 * and the database. The composition is the production one.
 *
 * It needs a disposable PostgreSQL on T09_TEST_PG_PORT. Without it the file
 * skips rather than passing quietly.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import express from 'express';
import pg from 'pg';
import { REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE, SESSION_COOKIE_NAME, type ChequebookOperation } from '@streaming-infra-manager/common';
import { createAuthRouter } from '../../src/api/routes/auth.js';
import { createChequebookRouter } from '../../src/api/routes/chequebook.js';
import { createRequireSession } from '../../src/api/middleware/requireSession.js';
import { requireSameSite } from '../../src/api/middleware/requireSameSite.js';
import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { AuthService } from '../../src/domain/auth/AuthService.js';
import { OpenStreams } from '../../src/domain/auth/OpenStreams.js';
import type { ChequebookService } from '../../src/domain/ChequebookService.js';
import type { ChequebookChainReader } from '../../src/domain/chequebook/ChequebookChainRegistry.js';
import { createChequebookOperationsService } from '../../src/domain/chequebook/createChequebookOperationsService.js';
import { InMemoryCredentialRepository } from '../support/InMemoryCredentialRepository.js';
import { InMemorySessionRepository } from '../support/InMemorySessionRepository.js';
import { InMemoryUserRepository } from '../support/InMemoryUserRepository.js';
import { instanceForProfile, transferContext, transactionHash } from '../support/chequebookOperations.js';
import { qualifiedBridge } from '../support/qualifiedBeeBridge.js';
import { seedSyntheticChequebookTarget, SyntheticTargetChequebookRepository } from '../support/syntheticChequebookTargets.js';
import { syntheticDockerBee } from '../support/syntheticDockerBee.js';

const port = Number(process.env.T09_TEST_PG_PORT);
// Only a loopback port is configurable. This suite cannot select a deployment database.
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't09_test', connectionTimeoutMillis: 30000 };
const PROFILE = 'test-deployment';
/** The port the synthetic container publishes, which the SQL reservation has to agree with. */
const PUBLISHED_BEE_PORT = 11633;
const OPERATOR = 'connected-operator';
const OPERATOR_PASSWORD = 'a-long-enough-synthetic-password';
const START_BLOCK = 500n;
const RECEIPT_BLOCK = 501n;

type ReceiptAnswer = 'pending' | 'success' | 'reverted';
const hashAt = (block: bigint) => block === START_BLOCK ? transferContext.startBlockHash : `0x${block.toString(16).padStart(64, '0')}`;

/**
 * One chain, scripted. It answers the same finalized history every time so a
 * case can say what changed rather than what the chain happened to do.
 */
function syntheticChain() {
  let answer: ReceiptAnswer = 'pending';
  let available = true;
  let receiptReads = 0;
  const unavailable = () => { throw new Error('synthetic-rpc-outage'); };
  const reader: ChequebookChainReader = {
    async chainId() { return available ? 100 : unavailable(); },
    async transactionCount() { return available ? '8' : unavailable(); },
    async blockTransactions() { return available ? null : unavailable(); },
    async blockHeader(block) {
      if (!available) unavailable();
      const number = block === 'finalized' || block === 'latest' ? (answer === 'pending' ? START_BLOCK : RECEIPT_BLOCK) : block;
      return { number: String(number), hash: hashAt(number), parentHash: hashAt(number - 1n) };
    },
    async transaction(hash) {
      if (!available) unavailable();
      if (answer === 'pending') return null;
      return { hash, chainId: 100, from: transferContext.nodeAddress, to: '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da',
        data: `0xa9059cbb${transferContext.chequebookAddress.slice(2).padStart(64, '0')}${(5000000000000000n).toString(16).padStart(64, '0')}`,
        nonce: '9', value: '0', blockNumber: String(RECEIPT_BLOCK), blockHash: hashAt(RECEIPT_BLOCK) };
    },
    async receipt(hash) {
      receiptReads++;
      if (!available) unavailable();
      if (answer === 'pending') return null;
      return { transactionHash: hash, from: transferContext.nodeAddress, to: '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da',
        blockNumber: String(RECEIPT_BLOCK), blockHash: hashAt(RECEIPT_BLOCK), status: answer === 'success' ? 'success' : 'reverted' };
    },
  };
  return { reader, receiptReads: () => receiptReads,
    answers(next: ReceiptAnswer) { answer = next; },
    outage(on: boolean) { available = !on; } };
}

async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean, description: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await read();
  while (!accepts(last)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(last)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
    last = await read();
  }
  return last;
}

interface ConnectedOptions {
  readonly dropNextResponse?: boolean;
  readonly receiptPollBudgetMs?: number;
  readonly pollIntervalMs?: number;
}

async function connected(t: TestContext, options: ConnectedOptions = {}) {
  const schema = `t09c_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool(connection);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ ...connection, max: 20, options: `-c search_path=${schema}` });
  const migrations = new URL('../../src/migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, migrations), 'utf8'));
  }
  await pool.query('INSERT INTO profiles (name, port_slot, instance_id, stack_version_id) VALUES ($1, 1, $2, 1)', [PROFILE, instanceForProfile(PROFILE)]);
  await seedSyntheticChequebookTarget(pool, PROFILE);
  await pool.query('UPDATE port_reservations SET port = $2 WHERE profile_name = $1', [PROFILE, PUBLISHED_BEE_PORT]);

  const directory = await mkdtemp(join(tmpdir(), 't09-connected-'));
  const socketPath = join(directory, 'docker.sock');
  let dropResponse = options.dropNextResponse === true;
  const beeFixtures: ReturnType<typeof syntheticDockerBee>[] = [];
  const connections = new Set<net.Socket>();
  const sockets = net.createServer(socket => {
    const bee = syntheticDockerBee(t, request => {
      if (request.method !== 'POST' || !dropResponse) return false;
      dropResponse = false;
      request.socket.destroy();
      return true;
    }, false);
    beeFixtures.push(bee);
    connections.add(socket);
    socket.on('error', () => {});
    socket.pipe(bee.transport).pipe(socket);
    socket.on('close', () => connections.delete(socket));
    bee.transport.once('close', () => socket.destroy());
  });
  sockets.listen(socketPath);
  await once(sockets, 'listening');

  const chain = syntheticChain();
  const repository = new SyntheticTargetChequebookRepository(pool, { receiptPollBudgetMs: options.receiptPollBudgetMs });
  const runtime = { rpcEndpoints: '{"100":"https://rpc.example.invalid"}', dockerTransports: JSON.stringify({
    localhost: { locator: { kind: 'unix', alias: 'localhost', socketPath }, qualificationIds: ['synthetic-only'] } }) };
  const dependencies = { repository, qualificationCatalog: [qualifiedBridge()], createChainReader: () => chain.reader,
    preparation: { cleanupGraceMs: 20, timeoutMs: 3000 },
    receiptPolling: { intervalMs: options.pollIntervalMs ?? 50 } };
  const service = createChequebookOperationsService(pool, runtime, dependencies);

  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const openStreams = new OpenStreams();
  const authService = new AuthService(users, sessions, new InMemoryCredentialRepository(users, sessions), openStreams);
  await authService.addUser(OPERATOR, OPERATOR_PASSWORD);
  const requireSession = createRequireSession(authService);
  const requests: string[] = [];
  const app = express();
  app.use(requireSameSite, express.json({ limit: '256kb' }));
  app.use((req, _res, next) => { requests.push(`${req.method} ${req.path}`); next(); });
  app.use('/auth', createAuthRouter(authService, requireSession));
  app.use(requireSession);
  app.use(createChequebookRouter({} as ChequebookService, service), errorHandler);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  const cleanup = async () => {
    await service.shutdown();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const socket of connections) socket.destroy();
    if (sockets.listening) await new Promise<void>(resolve => sockets.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  };
  let closed = false;
  t.after(async () => { if (!closed) { closed = true; await cleanup(); } });
  t.diagnostic(`Owned synthetic Docker socket ${socketPath}, schema ${schema}, API ${base}`);

  const login = await fetch(`${base}/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json', [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE },
    body: JSON.stringify({ username: OPERATOR, password: OPERATOR_PASSWORD }) });
  assert.equal(login.status, 204, 'the fixture operator signs in through the real login route');
  const cookiePair = login.headers.getSetCookie().find(value => value.startsWith(`${SESSION_COOKIE_NAME}=`))?.split(';')[0];
  assert.ok(cookiePair, 'sign-in set a session cookie');
  const headers = { cookie: cookiePair, [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE, 'content-type': 'application/json' };
  const accountId = (await users.findByUsername(OPERATOR))!.id;

  async function deposit(requestId = randomUUID(), amount = '5000000000000000') {
    const response = await fetch(`${base}/profiles/${PROFILE}/chequebook/deposit`, { method: 'POST', headers,
      body: JSON.stringify({ requestId, profileInstanceId: instanceForProfile(PROFILE), expectedAccountId: accountId, amount }),
      signal: AbortSignal.timeout(20_000) });
    return { status: response.status, body: await response.json() as { kind: string; operation: ChequebookOperation } };
  }
  async function check(id: string) {
    const response = await fetch(`${base}/chequebook/operations/${id}/check`, { method: 'POST', headers,
      body: JSON.stringify({ expectedAccountId: accountId }), signal: AbortSignal.timeout(20_000) });
    return { status: response.status, body: await response.json() as { operation: ChequebookOperation } };
  }
  const row = async (id: string) => (await repository.findById(id))!;

  return { base, headers, accountId, service, repository, pool, chain, requests, row, deposit, check, cleanup: async () => { closed = true; await cleanup(); },
    directory,
    beePosts: () => beeFixtures.reduce((total, fixture) => total + fixture.counts().posts, 0),
    beeRequests: () => beeFixtures.flatMap(fixture => fixture.beeRequests),
    checkRequests: () => requests.filter(entry => entry.endsWith('/check')),
    dropNextResponse() { dropResponse = true; },
    due: () => repository.listAwaitingReceipt({ intervalMs: 0, limit: 20 }) };
}

describe('the connected chequebook path over a real journal and an owned synthetic Bee', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  it('accepts a deposit, polls its receipt to settlement and admits the next intent', async t => {
    const h = await connected(t);
    h.service.start();
    const admitted = await h.deposit();
    assert.equal(admitted.status, 202);
    assert.equal(admitted.body.kind, 'admitted');
    assert.equal(admitted.body.operation.state, 'submitted');
    assert.equal(admitted.body.operation.transactionHash, transactionHash);
    assert.ok(admitted.body.operation.receiptPollUntil);
    assert.equal(h.beePosts(), 1);
    h.chain.answers('success');
    const settled = await until(() => h.row(admitted.body.operation.id), operation => operation.state === 'settled', 'the polled receipt');
    assert.equal(settled.receiptObservation?.kind, 'settled');
    assert.equal(settled.receiptPollUntil, admitted.body.operation.receiptPollUntil, 'settling never moved the budget');
    assert.ok(h.chain.receiptReads() > 0, 'the poller asked the chain');
    assert.deepEqual(h.checkRequests(), [], 'nobody pressed Check');
    const next = await h.deposit();
    assert.equal(next.status, 202);
    assert.equal(next.body.kind, 'admitted');
    assert.equal(h.beePosts(), 2);
  });

  it('records a reverted receipt without an operator action', async t => {
    const h = await connected(t);
    h.service.start();
    const admitted = await h.deposit();
    assert.equal(admitted.body.operation.state, 'submitted');
    h.chain.answers('reverted');
    const reverted = await until(() => h.row(admitted.body.operation.id), operation => operation.state === 'reverted', 'the reverted receipt');
    assert.equal(reverted.receiptObservation?.kind, 'reverted');
    assert.deepEqual(h.checkRequests(), []);
    assert.equal(h.beePosts(), 1);
  });

  it('leaves a lost response unknown, unpolled and blocking, until the operator recovers it', async t => {
    const h = await connected(t, { dropNextResponse: true });
    h.service.start();
    h.chain.answers('success');
    const admitted = await h.deposit();
    assert.equal(admitted.status, 202);
    assert.equal(admitted.body.operation.state, 'unknown');
    assert.equal(admitted.body.operation.failureReason, 'response_unavailable');
    assert.equal(admitted.body.operation.receiptPollUntil, null);
    assert.equal(h.beePosts(), 1);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(await h.due(), [], 'an unknown row is never owed a receipt check');
    assert.equal(h.chain.receiptReads(), 0, 'the poller inspected no receipt for a row with no hash');
    const busy = await h.deposit();
    assert.equal(busy.status, 409);
    assert.equal(busy.body.kind, 'busy');
    assert.equal(busy.body.operation.id, admitted.body.operation.id);
    const recovered = await h.check(admitted.body.operation.id);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.operation.state, 'unknown');
    assert.ok(recovered.body.operation.recoveryCheckedAt, 'the recovery pass was recorded');
    assert.ok(h.beeRequests().some(request => request.url === '/transactions'), 'recovery read the owned pending list');
    assert.equal(h.beePosts(), 1, 'recovery sent no second transfer');
  });

  it('keeps polling across an RPC outage and records the receipt once the chain answers', async t => {
    const h = await connected(t);
    h.service.start();
    const admitted = await h.deposit();
    const id = admitted.body.operation.id;
    h.chain.outage(true);
    const unavailable = await until(() => h.row(id), operation => operation.receiptObservation?.kind === 'could_not_check', 'the recorded outage');
    assert.equal(unavailable.state, 'submitted');
    assert.equal(unavailable.receiptObservation?.kind === 'could_not_check' && unavailable.receiptObservation.reason, 'rpc_unavailable');
    h.chain.answers('success');
    h.chain.outage(false);
    const settled = await until(() => h.row(id), operation => operation.state === 'settled', 'the receipt after the outage');
    assert.equal(settled.receiptObservation?.kind, 'settled');
    assert.deepEqual(h.checkRequests(), []);
  });

  it('stops polling when the budget is spent and leaves the chain to the operator', async t => {
    const h = await connected(t, { receiptPollBudgetMs: 700 });
    h.service.start();
    const admitted = await h.deposit();
    const id = admitted.body.operation.id;
    await until(() => h.row(id), operation => operation.receiptCheckedAt !== null, 'the first polled check');
    await until(async () => (await h.due()).length, length => length === 0, 'the spent budget');
    const spent = await h.row(id);
    assert.equal(spent.state, 'submitted');
    assert.ok(Date.parse(spent.receiptPollUntil!) <= Date.now(), 'the deadline is in the past');
    const readsBefore = h.chain.receiptReads();
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(h.chain.receiptReads(), readsBefore, 'a spent budget asks the chain nothing');
    h.chain.answers('success');
    const checked = await h.check(id);
    assert.equal(checked.body.operation.state, 'settled');
    assert.equal(h.chain.receiptReads(), readsBefore + 1, 'the manual check ran the inspector once');
    assert.deepEqual(await h.due(), [], 'a manual check never reopens the budget');
    assert.equal(checked.body.operation.receiptPollUntil, spent.receiptPollUntil);
  });

  it('resumes a live budget in a restarted manager and adopts nothing once it has passed', async t => {
    const h = await connected(t, { receiptPollBudgetMs: 4000 });
    const admitted = await h.deposit();
    const id = admitted.body.operation.id;
    assert.equal(admitted.body.operation.receiptCheckedAt, null, 'nothing polled before the manager started');
    const restarted = createChequebookOperationsService(h.pool, { rpcEndpoints: undefined, dockerTransports: undefined },
      { repository: h.repository, createChainReader: () => h.chain.reader, receiptPolling: { intervalMs: 50 } });
    restarted.start();
    await until(() => h.row(id), operation => operation.receiptCheckedAt !== null, 'the resumed check');
    await restarted.shutdown();
    await until(async () => (await h.due()).length, length => length === 0, 'the spent budget');
    const afterBudget = createChequebookOperationsService(h.pool, { rpcEndpoints: undefined, dockerTransports: undefined },
      { repository: h.repository, createChainReader: () => h.chain.reader, receiptPolling: { intervalMs: 50 } });
    afterBudget.start();
    const readsBefore = h.chain.receiptReads();
    await new Promise(resolve => setTimeout(resolve, 400));
    await afterBudget.shutdown();
    assert.equal(h.chain.receiptReads(), readsBefore, 'a passed budget is never adopted by a later manager');
    assert.equal((await h.row(id)).state, 'submitted');
  });

  it('replays the same request without a second transfer', async t => {
    const h = await connected(t);
    const requestId = randomUUID();
    const first = await h.deposit(requestId);
    assert.equal(first.body.kind, 'admitted');
    const again = await h.deposit(requestId);
    assert.equal(again.status, 202);
    assert.equal(again.body.kind, 'replayed');
    assert.equal(again.body.operation.id, first.body.operation.id);
    assert.equal(h.beePosts(), 1);
  });

  it('leaves no temporary socket directory behind', async t => {
    const h = await connected(t);
    const admitted = await h.deposit();
    assert.equal(admitted.body.operation.state, 'submitted');
    await h.cleanup();
    await assert.rejects(stat(h.directory), { code: 'ENOENT' });
    t.diagnostic(`Verified removed: ${h.directory}`);
  });
});
