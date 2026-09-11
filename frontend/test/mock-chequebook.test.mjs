import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createMockChequebookJournal } from '../dev/mock-chequebook.mjs';

async function fixture(t, options = {}) {
  let profile = { name: 'synthetic-test', instance_id: randomUUID() };
  let account = { id: 7 };
  const node = { ethereum: `0x${'11'.repeat(20)}`, bzz: '20000000000000000', xdai: '1000000000000000',
    chequebook: { address: `0x${'22'.repeat(20)}`, total: '10000000000000000', available: '10000000000000000' } };
  const dispatched = [];
  const journal = createMockChequebookJournal({ profileFor: () => profile, nodeFor: () => node, userFor: () => account,
    onSubmitted(operation) { dispatched.push(operation); }, ...options });
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
    replace() { profile = { ...profile, instance_id: randomUUID() }; }, remove() { profile = null; }, account(id) { account = id === null ? null : { id }; } };
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

test('mock lost Bee response stays unknown and exact replay never dispatches again', async t => {
  const h = await fixture(t, { responseFor: () => null });
  const input = h.input();
  const unknown = await (await h.request(depositPath, input)).json();
  assert.equal(unknown.operation.state, 'unknown');
  assert.equal(unknown.operation.transactionHash, null);
  assert.equal(unknown.operation.failureReason, 'response_unavailable');
  assert.deepEqual(unknown.responseEvidence, []);
  assert.equal((await (await h.request(exact(input.requestId))).json()).operation.id, unknown.operation.id);
  assert.equal((await (await h.request(depositPath, input)).json()).kind, 'replayed');
  assert.equal(h.dispatched.length, 1);
});

test('mock global history pages saved records after profile removal and requires authentication', async t => {
  const h = await fixture(t);
  const ids = [];
  for (let count = 0; count < 3; count++) {
    const admitted = await (await h.request(depositPath, h.input())).json();
    ids.push(admitted.operation.id);
    h.journal.observeReceipt(admitted.operation.id, receipt);
  }
  h.remove();
  const firstResponse = await h.request('/chequebook/operations?limit=2');
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(first.operations.length, 2);
  assert.equal(typeof first.nextCursor, 'string');
  assert.equal('responseEvidence' in first.operations[0], false);
  const second = await (await h.request(`/chequebook/operations?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
  assert.equal(second.operations.length, 1);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(new Set([...first.operations, ...second.operations].map(operation => operation.id)), new Set(ids));
  assert.equal((await (await h.request('/chequebook/operations?profileName=missing')).json()).operations.length, 0);
  assert.equal(h.dispatched.length, 3);
  h.account(null);
  assert.equal((await h.request('/chequebook/operations')).status, 401);
  assert.equal((await h.request(`/chequebook/operations/${ids[0]}`)).status, 401);
});

test('mock history rejects malformed pagination instead of silently returning an empty page', async t => {
  const h = await fixture(t);
  for (const query of ['limit=0', 'limit=101', 'limit=01', 'limit=1.5', 'limit=2&limit=3', 'cursor=broken', 'endpoint=synthetic-private-value']) {
    const response = await h.request(`/chequebook/operations?${query}`);
    assert.equal(response.status, 400, query);
    assert.ok(!(await response.text()).includes('synthetic-private-value'));
  }
  const empty = await (await h.request('/chequebook/operations')).json();
  assert.deepEqual(empty, { operations: [], nextCursor: null });
  assert.equal(h.dispatched.length, 0);
});

const completeNoMatch = operation => ({ kind: 'no_match', candidateHashes: [], scan: { headBlockNumber: '510', headBlockHash: `0x${'88'.repeat(32)}`,
  nextBlockNumber: operation.startBlockNumber, nextBlockHash: operation.startBlockHash, complete: true, candidateHashes: [] } });
const action = (id, kind) => `/chequebook/operations/${id}/${kind}`;

test('mock receipt checks are explicit and work after profile deletion without another transfer', async t => {
  let inspected = 0;
  const h = await fixture(t, { receiptFor: async () => { inspected++; return receipt; } });
  const input = h.input();
  const saved = await (await h.request(depositPath, input)).json();
  h.remove();
  assert.equal((await (await h.request(exact(input.requestId))).json()).operation.state, 'submitted');
  assert.equal(inspected, 0);
  const response = await h.request(action(saved.operation.id, 'check'), { expectedAccountId: 7 });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).operation.state, 'settled');
  assert.equal(inspected, 1);
  assert.equal(h.dispatched.length, 1);
});

test('mock recovery guards the current account and exact assertion revision with a server-derived actor', async t => {
  let inspections = 0;
  const h = await fixture(t, { responseFor: () => null, recoveryFor: async operation => { inspections++; return completeNoMatch(operation); } });
  const saved = await (await h.request(depositPath, h.input())).json();
  h.remove(); h.account(8);
  const assertion = { expectedAccountId: 7, expectedRevision: saved.operation.revision, amountPlur: saved.operation.amountPlur, confirmation: saved.assertionConfirmation };
  for (const [kind, input] of [['check', { expectedAccountId: 7 }], ['resolve', { expectedAccountId: 7, transactionHash: `0x${'aa'.repeat(32)}` }], ['assert', assertion]]) {
    const response = await h.request(action(saved.operation.id, kind), input);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'account_changed');
  }
  assert.equal(inspections, 0);
  assert.equal((await h.request(action(saved.operation.id, 'check'), { expectedAccountId: '8' })).status, 400);
  assert.equal((await h.request(action(saved.operation.id, 'assert'), { ...assertion, expectedAccountId: 8, actor: 'user:99' })).status, 400);
  assert.equal((await h.request(action(saved.operation.id, 'assert'), { ...assertion, expectedAccountId: 8 })).status, 409);
  const checked = await (await h.request(action(saved.operation.id, 'check'), { expectedAccountId: 8 })).json();
  assert.equal(checked.operation.recoveryObservation.kind, 'no_match');
  assert.equal((await h.request(action(saved.operation.id, 'assert'), { ...assertion, expectedAccountId: 8 })).status, 409);
  const accepted = await h.request(action(saved.operation.id, 'assert'), { ...assertion, expectedAccountId: 8, expectedRevision: checked.operation.revision });
  assert.equal(accepted.status, 200);
  const asserted = await accepted.json();
  assert.equal(asserted.operation.state, 'asserted');
  assert.equal(asserted.operation.assertion.actor, 'user:8');
  assert.deepEqual(Object.keys(asserted.operation.assertion).sort(), ['actor', 'amountPlur', 'assertedAt', 'confirmation']);
  assert.equal(h.dispatched.length, 1);
});

test('mock ambiguous retained candidates cannot become assertion eligibility when the next observation has no match', async t => {
  const candidates = [`0x${'aa'.repeat(32)}`, `0x${'bb'.repeat(32)}`];
  let next = () => ({ kind: 'ambiguous', candidateHashes: candidates });
  const h = await fixture(t, { responseFor: () => null, recoveryFor: async operation => next(operation) });
  const saved = await (await h.request(depositPath, h.input())).json();
  const first = await (await h.request(action(saved.operation.id, 'resolve'), { expectedAccountId: 7, transactionHash: candidates[0] })).json();
  assert.equal(first.operation.recoveryObservation.kind, 'ambiguous');
  next = completeNoMatch;
  const second = await (await h.request(action(saved.operation.id, 'check'), { expectedAccountId: 7 })).json();
  assert.equal(second.operation.recoveryObservation.kind, 'could_not_check');
  assert.equal(second.operation.recoveryObservation.reason, 'rpc_unavailable');
  assert.deepEqual(second.operation.recoveryObservation.candidateHashes, candidates);
  assert.equal((await h.request(action(saved.operation.id, 'assert'), { expectedAccountId: 7, expectedRevision: second.operation.revision,
    amountPlur: second.operation.amountPlur, confirmation: second.assertionConfirmation })).status, 409);
  assert.equal(h.dispatched.length, 1);
});

test('mock delayed recovery cannot replace evidence that arrived while its observation was pending', async t => {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const h = await fixture(t, { responseFor: () => null, recoveryFor: async operation => { enter(); await held; return completeNoMatch(operation); } });
  const saved = await (await h.request(depositPath, h.input())).json();
  const checking = h.request(action(saved.operation.id, 'check'), { expectedAccountId: 7 });
  const early = await Promise.race([entered.then(() => 'entered'), checking.then(() => 'response')]);
  assert.equal(early, 'entered', 'The authenticated check must invoke the synthetic recovery inspector');
  h.journal.observeResponse(saved.operation.id, `0x${'aa'.repeat(32)}`);
  release();
  const result = await (await checking).json();
  assert.equal(result.operation.state, 'submitted');
  assert.equal(result.operation.transactionHash, `0x${'aa'.repeat(32)}`);
  assert.equal(result.operation.recoveryObservation, null);
  assert.equal(h.dispatched.length, 1);
});
