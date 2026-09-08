import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';
import express from 'express';
import { chequebookAssertionConfirmation, REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE, SESSION_COOKIE_NAME } from '@streaming-infra-manager/common';
import { createChequebookRouter } from '../../src/api/routes/chequebook.js';
import { createRequireSession } from '../../src/api/middleware/requireSession.js';
import { requireSameSite } from '../../src/api/middleware/requireSameSite.js';
import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { ChequebookOperationsService } from '../../src/domain/chequebook/ChequebookOperationsService.js';
import { ChequebookSubmission } from '../../src/domain/chequebook/ChequebookSubmission.js';
import { ChequebookReceiptCheck } from '../../src/domain/chequebook/ChequebookReceiptCheck.js';
import { ChequebookRecovery } from '../../src/domain/chequebook/ChequebookRecovery.js';
import type { ChequebookRecoveryInspector } from '../../src/domain/chequebook/ChequebookRecoveryInspector.js';
import type { AuthService } from '../../src/domain/auth/AuthService.js';
import type { ChequebookService } from '../../src/domain/ChequebookService.js';
import { InMemoryChequebookOperations, operationCandidate, transactionHash, transferContext, transferIntent } from '../support/chequebookOperations.js';

async function testApi(options: { dropResponse?: boolean } = {}) {
  let prepares = 0;
  let posts = 0;
  let receipts = 0;
  let recoveries = 0;
  let present = true;
  let sessionToken = 'test-session';
  const repository = new InMemoryChequebookOperations();
  const submission = new ChequebookSubmission(repository, async () => {
    prepares++;
    if (!present) throw new Error('synthetic-private-connection-string');
    return { context: transferContext, dispose() {}, preflight: async () => {}, send: async () => { posts++; return { transactionHash }; } };
  });
  const receiptCheck = new ChequebookReceiptCheck(repository, async () => { receipts++; return { kind: 'pending', reason: 'awaiting_receipt' }; });
  const inspector = {
    async inspect() { recoveries++; return { observation: { kind: 'could_not_check', reason: 'rpc_unavailable', candidateHashes: [] }, candidates: [] }; },
    async inspectHash() { recoveries++; return { observation: { kind: 'could_not_check', reason: 'rpc_unavailable', candidateHashes: [] }, candidates: [] }; },
  } as unknown as ChequebookRecoveryInspector;
  const service = new ChequebookOperationsService(repository, submission, receiptCheck, new ChequebookRecovery(repository, inspector, receiptCheck));
  const app = express();
  app.use(requireSameSite);
  app.use(express.json());
  app.use(createRequireSession({ sessionFor: async token => ['test-session', 'other-session'].includes(token) ? { user: { id: token === 'test-session' ? 7 : 8, username: 'operator', isAdmin: false }, tokenHash: 'test-hash', expiresAt: new Date(Date.now() + 60_000) } : null } as AuthService));
  if (options.dropResponse) app.use((req, res, next) => { if (req.method === 'POST') res.json = () => { req.socket.destroy(); return res; }; next(); });
  app.use(createChequebookRouter({ summary: async () => ({ source: 'summary' }) } as unknown as ChequebookService, service));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  return { repository, service, counts: () => ({ prepares, posts, receipts, recoveries }), removeProfile() { present = false; },
    switchAccount(id: 7 | 8) { sessionToken = id === 7 ? 'test-session' : 'other-session'; },
    async request(method: string, path: string, body?: unknown, authenticated = true, sameSite = true) {
      return fetch(`${url}${path}`, { method, headers: { 'content-type': 'application/json', ...(authenticated ? { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` } : {}),
        ...(sameSite ? { [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    }, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const path = '/profiles/test-deployment/chequebook/deposit';
const operationsPath = '/chequebook/operations';

describe('authenticated transaction-journal API', () => {
  it('requires a session on every operation route and the same-site header on writes', async t => {
    const api = await testApi(); t.after(() => api.close());
    const id = operationCandidate().id;
    for (const [method, route] of [['POST', path], ['GET', operationsPath], ['GET', `${operationsPath}/${id}`],
      ['GET', `${operationsPath}/by-request/${id}`], ['POST', `${operationsPath}/${id}/check`], ['POST', `${operationsPath}/${id}/resolve`], ['POST', `${operationsPath}/${id}/assert`]]) {
      assert.equal((await api.request(method!, route!, method === 'GET' ? undefined : {}, false)).status, 401);
    }
    assert.equal((await api.request('POST', path, {}, true, false)).status, 403);
    assert.deepEqual(api.counts(), { prepares: 0, posts: 0, receipts: 0, recoveries: 0 });
  });

  it('requires a request UUID and rejects caller actor, endpoint, chain and malformed amounts', async t => {
    const api = await testApi(); t.after(() => api.close());
    const intent = transferIntent();
    for (const body of [{ amount: intent.amountPlur }, { amount: 1, requestId: intent.requestId, profileInstanceId: intent.profileInstanceId, expectedAccountId: 7 }, { amount: '01', requestId: intent.requestId, profileInstanceId: intent.profileInstanceId, expectedAccountId: 7 },
      ...[undefined, null, '', 'old-deployment'].map(profileInstanceId => ({ amount: intent.amountPlur, requestId: intent.requestId, profileInstanceId, expectedAccountId: 7 })),
      ...[undefined, null, 0, -1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1].map(expectedAccountId => ({ amount: intent.amountPlur, requestId: intent.requestId, profileInstanceId: intent.profileInstanceId, expectedAccountId })),
      ...['actor', 'requestedBy', 'endpoint', 'chainId', 'contract'].map(key => ({ amount: intent.amountPlur, requestId: intent.requestId, profileInstanceId: intent.profileInstanceId, expectedAccountId: 7, [key]: 'synthetic-private-value' }))]) {
      const response = await api.request('POST', path, body);
      assert.equal(response.status, 400);
      assert.ok(!(await response.text()).includes('synthetic-private-value'));
    }
    assert.equal(api.counts().posts, 0);
    const response = await api.request('POST', path, { amount: intent.amountPlur, requestId: intent.requestId, profileInstanceId: intent.profileInstanceId, expectedAccountId: 7 });
    assert.equal(response.status, 202);
    const result = await response.json();
    assert.equal(result.operation.requestedBy, 'user:7');
    assert.equal(result.operation.profileInstanceId, intent.profileInstanceId);
    assert.equal(result.operation.state, 'submitted');
    assert.equal(result.assertionConfirmation, chequebookAssertionConfirmation(intent.amountPlur));
    assert.deepEqual(result.responseEvidence, []);
    const conflict = await api.request('POST', path, { amount: '1', requestId: intent.requestId, profileInstanceId: intent.profileInstanceId, expectedAccountId: 7 });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).kind, 'conflict');
    assert.equal(api.counts().posts, 1);
  });

  it('refuses a saved intent after cookie account switching before any preparation or journal mutation', async t => {
    const api = await testApi(); t.after(() => api.close());
    const intent = transferIntent();
    const body = { amount: intent.amountPlur, requestId: intent.requestId, profileInstanceId: intent.profileInstanceId, expectedAccountId: 7 };
    api.switchAccount(8);
    const refused = await api.request('POST', path, body);
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: 'account_changed', message: 'The signed-in account changed. Sign in with the account that confirmed this transfer.' });
    assert.deepEqual(api.counts(), { prepares: 0, posts: 0, receipts: 0, recoveries: 0 });
    assert.equal(await api.repository.findByRequestId(intent.requestId), null);

    api.switchAccount(7);
    const accepted = await api.request('POST', path, body);
    assert.equal(accepted.status, 202);
    const original = await accepted.json();
    assert.equal(original.operation.requestedBy, 'user:7');
    api.removeProfile();
    api.switchAccount(8);
    assert.equal((await api.request('POST', path, body)).status, 409);
    assert.deepEqual(await api.repository.findByRequestId(intent.requestId), original.operation);
    api.switchAccount(7);
    const replayed = await api.request('POST', path, body);
    assert.equal(replayed.status, 202);
    assert.equal((await replayed.json()).kind, 'replayed');
    assert.deepEqual(api.counts(), { prepares: 1, posts: 1, receipts: 0, recoveries: 0 });
  });

  it('refuses recovery writes after an account switch before any service or journal work', async t => {
    const api = await testApi(); t.after(() => api.close());
    const operation = (await api.repository.admit(operationCandidate())).operation;
    const inputs = [
      ['check', {}], ['resolve', { transactionHash }],
      ['assert', { amountPlur: operation.amountPlur, confirmation: chequebookAssertionConfirmation(operation.amountPlur) }],
    ] as const;
    let calls = 0;
    const read = api.repository.findWithResponses.bind(api.repository);
    api.repository.findWithResponses = async id => { calls++; return read(id); };
    api.switchAccount(8);
    for (const [action, input] of inputs) {
      const response = await api.request('POST', `${operationsPath}/${operation.id}/${action}`, { ...input, expectedAccountId: 7 });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: 'account_changed', message: 'The signed-in account changed. Review this action again with your current account.' });
    }
    assert.equal(calls, 0);
    assert.deepEqual(api.counts(), { prepares: 0, posts: 0, receipts: 0, recoveries: 0 });
    assert.deepEqual(await api.repository.findById(operation.id), operation);

    const checked = await api.request('POST', `${operationsPath}/${operation.id}/check`, { expectedAccountId: 8 });
    assert.equal(checked.status, 200, 'Current authenticated account may recover another account’s operation');
    assert.equal(api.counts().recoveries, 1);
    assert.equal(api.counts().posts, 0);
  });

  it('strictly validates recovery account preconditions without returning private input', async t => {
    const api = await testApi(); t.after(() => api.close());
    const operation = operationCandidate();
    const errors: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args));
    for (const [action, input] of [
      ['check', {}], ['resolve', { transactionHash }],
      ['assert', { amountPlur: operation.amountPlur, confirmation: chequebookAssertionConfirmation(operation.amountPlur) }],
    ] as const) {
      for (const expectedAccountId of [undefined, null, 0, -1, 1.5, 'synthetic-private-account', Number.MAX_SAFE_INTEGER + 1]) {
        const response = await api.request('POST', `${operationsPath}/${operation.id}/${action}`, { ...input, expectedAccountId });
        assert.equal(response.status, 400);
        assert.ok(!(await response.text()).includes('synthetic-private-account'));
      }
      const extra = await api.request('POST', `${operationsPath}/${operation.id}/${action}`, { ...input, expectedAccountId: 7, actor: 'synthetic-private-actor' });
      assert.equal(extra.status, 400);
      assert.ok(!(await extra.text()).includes('synthetic-private-actor'));
    }
    assert.ok(!JSON.stringify(errors).includes('synthetic-private'));
    assert.deepEqual(api.counts(), { prepares: 0, posts: 0, receipts: 0, recoveries: 0 });
  });

  it('recovers an exact request key after losing the HTTP response and removing the profile', async t => {
    const api = await testApi({ dropResponse: true }); t.after(() => api.close());
    const intent = transferIntent();
    await assert.rejects(api.request('POST', path, { amount: intent.amountPlur, requestId: intent.requestId, profileInstanceId: intent.profileInstanceId, expectedAccountId: 7 }));
    api.removeProfile();
    const response = await api.request('GET', `${operationsPath}/by-request/${intent.requestId}`);
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.operation.requestId, intent.requestId);
    assert.equal(detail.operation.transactionHash, transactionHash);
    assert.deepEqual(api.counts(), { prepares: 1, posts: 1, receipts: 0, recoveries: 0 });
    assert.equal((await api.request('GET', `${operationsPath}/by-request/${transferIntent().requestId}`)).status, 404);
  });

  it('checks receipts and scans from frozen records without preparing or resending a transfer', async t => {
    const api = await testApi(); t.after(() => api.close());
    const submitted = await api.service.submit(transferIntent());
    api.removeProfile();
    const checked = await api.request('POST', `${operationsPath}/${submitted.operation.id}/check`, { expectedAccountId: 7 });
    assert.equal(checked.status, 200);
    assert.equal((await checked.json()).operation.receiptObservation.kind, 'pending');
    const candidate = operationCandidate({ nodeAddress: `0x${'89'.repeat(20)}` });
    const unknown = (await api.repository.admit(candidate)).operation;
    await api.repository.recordSubmission(unknown.id, { state: 'unknown', transactionHash: null, failureReason: 'response_unavailable' });
    assert.equal((await api.request('POST', `${operationsPath}/${unknown.id}/check`, { expectedAccountId: 7 })).status, 200);
    assert.equal((await api.request('POST', `${operationsPath}/${unknown.id}/resolve`, { transactionHash, expectedAccountId: 7 })).status, 200);
    assert.deepEqual(api.counts(), { prepares: 1, posts: 1, receipts: 1, recoveries: 2 });
  });

  it('requires current no-match evidence and uses the authenticated actor for the exact assertion', async t => {
    const api = await testApi(); t.after(() => api.close());
    const operation = (await api.repository.admit(operationCandidate())).operation;
    const unknown = await api.repository.recordSubmission(operation.id, { state: 'unknown', transactionHash: null, failureReason: 'response_unavailable' });
    const body = { expectedAccountId: 7, amountPlur: operation.amountPlur, confirmation: chequebookAssertionConfirmation(operation.amountPlur) };
    assert.equal((await api.request('POST', `${operationsPath}/${operation.id}/assert`, body)).status, 409);
    await api.repository.recordRecovery(unknown, { kind: 'no_match', candidateHashes: [], scan: { headBlockNumber: '500', headBlockHash: transferContext.startBlockHash,
      nextBlockNumber: '500', nextBlockHash: transferContext.startBlockHash, complete: true, candidateHashes: [] } }, []);
    assert.equal((await api.request('POST', `${operationsPath}/${operation.id}/assert`, { ...body, actor: 'forged' })).status, 400);
    assert.equal((await api.request('POST', `${operationsPath}/${operation.id}/assert`, { ...body, confirmation: 'I agree' })).status, 400);
    const response = await api.request('POST', `${operationsPath}/${operation.id}/assert`, body);
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.operation.state, 'asserted');
    assert.equal(detail.operation.assertion.actor, 'user:7');
    assert.deepEqual(Object.keys(detail.operation.assertion).sort(), ['actor', 'amountPlur', 'assertedAt', 'confirmation']);
    assert.equal(api.counts().posts, 0);
  });

  it('bounds history inputs and exposes conflict evidence without masking the conflict', async t => {
    const api = await testApi(); t.after(() => api.close());
    for (const suffix of ['?limit=0', '?limit=101', '?limit=2&limit=3', '?cursor=broken', '?endpoint=synthetic-private-value']) {
      assert.equal((await api.request('GET', `${operationsPath}${suffix}`)).status, 400);
    }
    const operation = (await api.repository.admit(operationCandidate())).operation;
    api.repository.rows.set(operation.id, { ...operation, state: 'settled', transactionHash, failureReason: 'hash_conflict',
      recoveryObservation: { kind: 'could_not_check', reason: 'attribution_conflict', candidateHashes: [transactionHash], additionalEvidenceInResponseJournal: true } });
    api.repository.listSubmissionResponses = async () => [{ transactionHash: `0x${'99'.repeat(32)}`, receivedAt: operation.createdAt, ownership: 'conflict' }];
    const history = await (await api.request('GET', `${operationsPath}?limit=1&profileName=${operation.profileName}`)).json();
    assert.equal(history.operations[0].id, operation.id);
    const detail = await (await api.request('GET', `${operationsPath}/${operation.id}`)).json();
    assert.equal(detail.operation.failureReason, 'hash_conflict');
    assert.equal(detail.responseEvidence[0].ownership, 'conflict');
    assert.equal(detail.operation.recoveryObservation.additionalEvidenceInResponseJournal, true);
  });

  it('returns only fixed safe errors for unavailable history or detail storage', async t => {
    const api = await testApi(); t.after(() => api.close());
    const errors: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args));
    api.repository.listHistory = async () => { throw new Error('synthetic-private-connection-string'); };
    api.repository.findWithResponses = async () => { throw new Error('synthetic-private-connection-string'); };
    for (const route of [operationsPath, `${operationsPath}/${operationCandidate().id}`]) {
      const response = await api.request('GET', route);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, 'chequebook_journal_unavailable');
    }
    assert.ok(!JSON.stringify(errors).includes('synthetic-private-connection-string'));
  });
});
