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
import { randomUUID } from 'node:crypto';
import fs, { stat } from 'node:fs/promises';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { describe, it, type TestContext } from 'node:test';
import pg from 'pg';
import { REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE, SESSION_COOKIE_NAME, type ChequebookOperation } from '@streaming-infra-manager/common';
import { createChequebookOperationsService } from '../../src/domain/chequebook/createChequebookOperationsService.js';
import { instanceForProfile, transactionHash } from '../support/chequebookOperations.js';
import { CONNECTED_OPERATOR, CONNECTED_OPERATOR_PASSWORD, CONNECTED_PROFILE, connectedChequebookApi, connectedChequebookAuth,
  startConnectedChequebook, type ConnectedChequebookOptions } from '../support/connectedChequebook.js';

const port = Number(process.env.T09_TEST_PG_PORT);

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

async function connected(t: TestContext, options: Omit<ConnectedChequebookOptions, 'pgPort'> = {}) {
  const backend = await startConnectedChequebook({ ...options, pgPort: port });
  const auth = await connectedChequebookAuth();
  const requests: string[] = [];
  const server = http.createServer(connectedChequebookApi(backend.service, auth,
    { onRequest: (method, path) => requests.push(`${method} ${path}`) }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await backend.close();
  };
  t.after(close);
  t.diagnostic(`Owned synthetic Docker socket in ${backend.directory}, schema ${backend.schema}, API ${base}`);

  const login = await fetch(`${base}/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json', [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE },
    body: JSON.stringify({ username: CONNECTED_OPERATOR, password: CONNECTED_OPERATOR_PASSWORD }) });
  assert.equal(login.status, 204, 'the fixture operator signs in through the real login route');
  const cookiePair = login.headers.getSetCookie().find(value => value.startsWith(`${SESSION_COOKIE_NAME}=`))?.split(';')[0];
  assert.ok(cookiePair, 'sign-in set a session cookie');
  const headers = { cookie: cookiePair, [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE, 'content-type': 'application/json' };
  const accountId = await auth.accountId();

  async function deposit(requestId = randomUUID(), amount = '5000000000000000') {
    const response = await fetch(`${base}/profiles/${CONNECTED_PROFILE}/chequebook/deposit`, { method: 'POST', headers,
      body: JSON.stringify({ requestId, profileInstanceId: instanceForProfile(CONNECTED_PROFILE), expectedAccountId: accountId, amount }),
      signal: AbortSignal.timeout(20_000) });
    return { status: response.status, body: await response.json() as { kind: string; operation: ChequebookOperation } };
  }
  async function check(id: string) {
    const response = await fetch(`${base}/chequebook/operations/${id}/check`, { method: 'POST', headers,
      body: JSON.stringify({ expectedAccountId: accountId }), signal: AbortSignal.timeout(20_000) });
    return { status: response.status, body: await response.json() as { operation: ChequebookOperation } };
  }
  return { ...backend, base, headers, accountId, deposit, check, close,
    row: async (id: string) => (await backend.repository.findById(id))!,
    checkRequests: () => requests.filter(entry => entry.endsWith('/check')),
    due: () => backend.repository.listAwaitingReceipt({ intervalMs: 0, limit: 20 }) };
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
    assert.ok(h.pollerLines().some(line => line.includes(`${admitted.body.operation.id} settled`)), 'the poller recorded what it changed');
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

  function adminPool(t: TestContext) {
    const admin = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', database: 't09_test', connectionTimeoutMillis: 30000 });
    t.after(() => admin.end());
    return admin;
  }

  it('unwinds a start that fails partway and leaves no schema behind', async t => {
    const admin = adminPool(t);
    const schemas = async () => (await admin.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 't09c\\_%'")).rowCount;
    const before = await schemas();
    t.mock.method(fs, 'mkdtemp', async () => { throw new Error('synthetic-directory-failure'); });
    syncBuiltinESMExports();
    try {
      await assert.rejects(startConnectedChequebook({ pgPort: port }), /synthetic-directory-failure/);
    } finally {
      // A failure here would otherwise leave node:fs mocked for every later case in this file.
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal(await schemas(), before, 'the schema the failed start created was dropped again');
  });

  it('finishes every close step even when the first one fails', async t => {
    const h = await connected(t);
    const admin = adminPool(t);
    assert.equal((await h.deposit()).body.operation.state, 'submitted');
    h.service.shutdown = async () => { throw new Error('synthetic-shutdown-failure'); };
    await assert.rejects(h.close(), /synthetic-shutdown-failure/);
    await assert.rejects(stat(h.directory), { code: 'ENOENT' }, 'the socket directory is removed anyway');
    await assert.rejects(h.pool.query('SELECT 1'), /after calling end/i, 'the journal pool is closed anyway');
    assert.equal((await admin.query('SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1', [h.schema])).rowCount, 0,
      'the disposable schema is dropped anyway');
  });

  it('leaves no temporary socket directory behind', async t => {
    const h = await connected(t);
    const admitted = await h.deposit();
    assert.equal(admitted.body.operation.state, 'submitted');
    await h.close();
    await assert.rejects(stat(h.directory), { code: 'ENOENT' });
    t.diagnostic(`Verified removed: ${h.directory}`);
  });
});
