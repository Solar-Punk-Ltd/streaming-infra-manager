import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchChrome, waitFor } from './support/chrome.mjs';
import { json, launchTransferFixture, readJson } from './support/transfer-fixture.mjs';

const operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const stamp = '2026-09-08T00:00:00.000Z';
const hash = `0x${'55'.repeat(32)}`;
function detail() {
  return { operation: { id: operationId, requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', requestedBy: 'user:7', profileName: 'deleted-profile',
    profileInstanceId: '11111111-1111-4111-8111-111111111111', direction: 'deposit', amountPlur: '5000000000000000', state: 'unknown',
    chainId: 100, nodeAddress: `0x${'11'.repeat(20)}`, chequebookAddress: `0x${'22'.repeat(20)}`, tokenAddress: `0x${'33'.repeat(20)}`,
    startBlockNumber: '500', startBlockHash: `0x${'44'.repeat(32)}`, nonceLowerBound: '9', nonceQueryTag: '0x1f4',
    transactionHash: null, failureReason: 'response_unavailable', revision: '2', dispatchStartedAt: stamp,
    receiptObservation: null, receiptCheckedAt: null, receiptPollUntil: null, recoveryObservation: null, recoveryCheckedAt: null, assertion: null,
    createdAt: stamp, updatedAt: stamp }, responseEvidence: [], assertionConfirmation: 'I accept that retrying 0.5 BZZ may pay twice.' };
}
async function open(t, fixture) {
  const browser = await launchChrome(t, fixture.origin);
  await browser.call('Page.navigate', { url: `${fixture.origin}/dev/t09-intent-tests.html` });
  await waitFor(() => browser.evaluate("typeof document.querySelector('#run')?.onclick === 'function'"));
  await browser.evaluate(`(async () => {
    globalThis.run = (await import('/src/transfers/transferRecoveryApi.ts')).runTransferRecovery;
    globalThis.reviewed = ${JSON.stringify(detail())};
    globalThis.signal = new AbortController().signal;
    return true;
  })()`);
  return browser;
}

test('explicit recovery uses the current account and exact action body without profile reads or money sends', async t => {
  const requests = [];
  const fixture = await launchTransferFixture(t, async (req, res) => {
    requests.push({ method: req.method, path: req.url, body: await readJson(req), sameSite: req.headers['x-requested-with'] });
    return json(res, 200, { ...detail(), operation: { ...detail().operation, revision: '3' } });
  });
  const browser = await open(t, fixture);
  for (const action of [{ kind: 'check' }, { kind: 'resolve', transactionHash: hash },
    { kind: 'assert', expectedRevision: '2', amountPlur: detail().operation.amountPlur, confirmation: detail().assertionConfirmation }]) {
    const result = await browser.evaluate(`run(reviewed, 8, ${JSON.stringify(action)}, signal)`);
    assert.equal(result.operation.id, operationId);
  }
  assert.deepEqual(requests, [
    { method: 'POST', path: `/chequebook/operations/${operationId}/check`, body: { expectedAccountId: 8 }, sameSite: 'streaming-infra-manager' },
    { method: 'POST', path: `/chequebook/operations/${operationId}/resolve`, body: { expectedAccountId: 8, transactionHash: hash }, sameSite: 'streaming-infra-manager' },
    { method: 'POST', path: `/chequebook/operations/${operationId}/assert`, body: { expectedAccountId: 8, expectedRevision: '2', amountPlur: detail().operation.amountPlur, confirmation: detail().assertionConfirmation }, sameSite: 'streaming-infra-manager' },
  ]);
  for (const [account, action] of [[0, { kind: 'check' }], [8, { kind: 'resolve', transactionHash: 'not-a-hash' }],
    [8, { kind: 'assert', expectedRevision: '02', amountPlur: detail().operation.amountPlur, confirmation: detail().assertionConfirmation }],
    [8, { kind: 'assert', expectedRevision: '1', amountPlur: detail().operation.amountPlur, confirmation: detail().assertionConfirmation }],
    [8, { kind: 'assert', expectedRevision: '2', amountPlur: '1', confirmation: detail().assertionConfirmation }],
    [8, { kind: 'assert', expectedRevision: '2', amountPlur: detail().operation.amountPlur, confirmation: 'I think it is safe' }]]) {
    const result = await browser.evaluate(`run(reviewed, ${account}, ${JSON.stringify(action)}, signal).catch(error => ({ reason: error.reason, outcome: error.outcome }))`);
    assert.deepEqual(result, { reason: 'invalid_input', outcome: 'refused' });
  }
  assert.equal(requests.length, 3);
  assert.deepEqual(browser.errors, []);
  assert.deepEqual(browser.blockedRequests, []);
});

test('recovery rejects contradictory detail, uses fixed errors, and never retries a lost action response', async t => {
  let mode = 'lost';
  const writes = [];
  const fixture = await launchTransferFixture(t, async (req, res) => {
    writes.push({ path: req.url, body: await readJson(req) });
    if (mode === 'lost') { req.socket.destroy(); return; }
    if (mode === 'signed_out') return json(res, 401, {});
    if (mode === 'wrong_identity') return json(res, 200, { ...detail(), operation: { ...detail().operation, nodeAddress: `0x${'99'.repeat(20)}` } });
    if (mode === 'old_revision') return json(res, 200, { ...detail(), operation: { ...detail().operation, revision: '1' } });
    if (mode === 'missing_evidence') return json(res, 200, { operation: detail().operation });
    if (mode === 'wrong_confirmation') return json(res, 200, { ...detail(), assertionConfirmation: 'safe' });
    if (mode === 'invalid_json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('synthetic-private-diagnostic'); return; }
    const status = mode === 'chequebook_operation_not_found' ? 404 : mode === 'validation_error' ? 400 : mode === 'unknown' ? 500 : 409;
    return json(res, status, { error: mode, message: 'synthetic-private-diagnostic', cause: 'synthetic-private-cause' });
  });
  const browser = await open(t, fixture);
  const cases = [['lost', 'unavailable', 'unknown'], ['wrong_identity', 'identity_conflict', 'unknown'], ['old_revision', 'invalid_response', 'unknown'],
    ['missing_evidence', 'invalid_response', 'unknown'], ['wrong_confirmation', 'invalid_response', 'unknown'], ['invalid_json', 'invalid_response', 'unknown'],
    ['account_changed', 'account_changed', 'refused'], ['operation_changed', 'operation_changed', 'refused'],
    ['chequebook_recovery_required', 'recovery_required', 'refused'], ['chequebook_operation_not_found', 'not_found', 'refused'],
    ['validation_error', 'invalid_input', 'refused'], ['unknown', 'unavailable', 'unknown']];
  for (const [next, reason, outcome] of cases) {
    mode = next;
    const result = await browser.evaluate("run(reviewed, 8, { kind: 'check' }, signal).catch(error => ({ name: error.name, reason: error.reason, outcome: error.outcome, message: error.message, cause: error.cause }))");
    assert.equal(result.name, 'TransferRecoveryError');
    assert.equal(result.reason, reason, mode);
    assert.equal(result.outcome, outcome, mode);
    assert.ok(!JSON.stringify(result).includes('synthetic-private'));
    assert.equal(result.cause, undefined);
  }
  mode = 'signed_out';
  await browser.evaluate("import('/src/http.ts').then(module => module.setSessionEndedHandler(() => { globalThis.sessionEnded = true; }))");
  assert.equal(await browser.evaluate("run(reviewed, 8, { kind: 'check' }, signal).catch(error => error.name)"), 'SessionEndedError');
  assert.equal(await browser.evaluate('globalThis.sessionEnded'), true);
  assert.equal(writes.length, cases.length + 1, 'Exactly one POST per explicit call, including response loss');
  assert.ok(writes.every(write => write.path === `/chequebook/operations/${operationId}/check`));
  assert.deepEqual(browser.errors, []);
  assert.deepEqual(browser.blockedRequests, []);
});
