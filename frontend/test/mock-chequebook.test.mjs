import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createMockChequebookJournal } from '../dev/mock-chequebook.mjs';

async function fixture(t) {
  let profile = { name: 'synthetic-test', instance_id: randomUUID() };
  let account = { id: 7 };
  const node = { ethereum: `0x${'11'.repeat(20)}`, bzz: '20000000000000000', xdai: '1000000000000000',
    chequebook: { address: `0x${'22'.repeat(20)}`, total: '10000000000000000', available: '10000000000000000' } };
  const dispatched = [];
  const journal = createMockChequebookJournal({ profileFor: () => profile, nodeFor: () => node, userFor: () => account,
    onSubmitted(operation) { dispatched.push(operation); } });
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    for (const [method, pattern, handler] of journal.routes) {
      const match = pattern.exec(path);
      if (match && method === req.method) { void Promise.resolve(handler(req, res, match.slice(1))).catch(() => { res.writeHead(500); res.end(); }); return; }
    }
    res.writeHead(404); res.end();
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { journal, node, dispatched, request: (path, body) => fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) }),
    input: () => ({ requestId: randomUUID(), profileInstanceId: profile.instance_id, expectedAccountId: 7, amount: '5000000000000000' }),
    replace() { profile = { ...profile, instance_id: randomUUID() }; }, remove() { profile = null; }, account(id) { account = { id }; } };
}
const depositPath = '/profiles/synthetic-test/chequebook/deposit';
const exact = requestId => `/chequebook/operations/by-request/${requestId}`;
const receipt = { kind: 'settled', receiptBlockNumber: '501', receiptBlockHash: `0x${'77'.repeat(32)}`,
  finalizedBlockNumber: '510', finalizedBlockHash: `0x${'88'.repeat(32)}` };

test('mock journal retains exact identity across response loss, profile deletion and busy admission', async t => {
  const h = await fixture(t);
  const input = h.input();
  const admitted = await (await h.request(depositPath, input)).json();
  assert.equal(admitted.kind, 'admitted');
  assert.equal(admitted.operation.state, 'submitted');
  assert.equal(admitted.operation.requestedBy, 'user:7');
  assert.equal(h.dispatched.length, 1);
  const busyResponse = await h.request(depositPath, h.input());
  assert.equal(busyResponse.status, 409);
  const busy = await busyResponse.json();
  assert.equal(busy.kind, 'busy');
  assert.equal(busy.operation.requestId, input.requestId);
  h.remove();
  assert.equal((await (await h.request(exact(input.requestId))).json()).operation.id, admitted.operation.id);
  assert.equal((await (await h.request(depositPath, input)).json()).kind, 'replayed');
  assert.equal(h.dispatched.length, 1);
  assert.equal((await h.request(exact(randomUUID()))).status, 404);
});

test('mock journal refuses account or instance changes and immutable request mutations', async t => {
  const h = await fixture(t);
  const input = h.input();
  h.account(8);
  assert.equal((await (await h.request(depositPath, input)).json()).error, 'account_changed');
  assert.equal(h.dispatched.length, 0);
  h.account(7); h.replace();
  assert.equal((await (await h.request(depositPath, input)).json()).error, 'chequebook_profile_changed');
  const current = h.input();
  await h.request(depositPath, current);
  assert.equal((await (await h.request(depositPath, { ...current, amount: '1' })).json()).kind, 'conflict');
  for (const changed of [{ requestedBy: 'user:8' }, { endpoint: 'http://synthetic.invalid' }, { amount: 1 }, { expectedAccountId: '7' }]) {
    assert.equal((await h.request(depositPath, { ...current, ...changed })).status, 400);
  }
  assert.equal(h.dispatched.length, 1);
});

test('balance changes cannot settle a mock operation and conflict evidence protects a terminal node', async t => {
  const h = await fixture(t);
  const input = h.input();
  const admitted = await (await h.request(depositPath, input)).json();
  h.node.bzz = '10000000000000000';
  h.node.chequebook.total = '15000000000000000';
  assert.equal((await (await h.request(exact(input.requestId))).json()).operation.state, 'submitted');
  h.journal.observeReceipt(admitted.operation.id, receipt);
  const settled = await (await h.request(exact(input.requestId))).json();
  assert.equal(settled.operation.state, 'settled');
  assert.deepEqual(settled.operation.receiptObservation, receipt);
  h.journal.observeResponse(admitted.operation.id, `0x${'99'.repeat(32)}`);
  const conflicted = await (await h.request(exact(input.requestId))).json();
  assert.equal(conflicted.operation.state, 'settled');
  assert.equal(conflicted.operation.failureReason, 'hash_conflict');
  assert.equal(conflicted.responseEvidence.at(-1).ownership, 'conflict');
  assert.equal((await (await h.request(depositPath, h.input())).json()).kind, 'busy');
  assert.equal(h.dispatched.length, 1);
});

test('mock preflight refusal is recorded without a dispatch and a later explicit intent can proceed', async t => {
  const h = await fixture(t);
  h.node.xdai = '0';
  const input = h.input();
  const refused = await (await h.request(depositPath, input)).json();
  assert.equal(refused.operation.state, 'rejected');
  assert.equal(refused.operation.failureReason, 'preflight_failed');
  assert.equal(refused.operation.dispatchStartedAt, null);
  assert.equal(h.dispatched.length, 0);
  h.node.xdai = '1';
  assert.equal((await (await h.request(depositPath, input)).json()).operation.state, 'rejected');
  assert.equal((await (await h.request(depositPath, h.input())).json()).operation.state, 'submitted');
  assert.equal(h.dispatched.length, 1);
});
