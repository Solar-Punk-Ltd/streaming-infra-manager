import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchChrome, waitFor } from './support/chrome.mjs';
import { json, launchTransferFixture, readJson } from './support/transfer-fixture.mjs';

const intent = { requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', accountId: 7, profileName: 'synthetic-test',
  profileInstanceId: '11111111-1111-4111-8111-111111111111', direction: 'deposit', amountPlur: '5000000000000000', createdAt: '2026-09-08T00:00:00.000Z' };
const operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const exactPath = `/chequebook/operations/by-request/${intent.requestId}`;
function detail() {
  return { operation: { id: operationId, requestId: intent.requestId, requestedBy: 'user:7', profileName: intent.profileName,
    profileInstanceId: intent.profileInstanceId, direction: intent.direction, amountPlur: intent.amountPlur, state: 'settled',
    chainId: 100, nodeAddress: `0x${'11'.repeat(20)}`, chequebookAddress: `0x${'22'.repeat(20)}`, tokenAddress: `0x${'33'.repeat(20)}`,
    startBlockNumber: '500', startBlockHash: `0x${'44'.repeat(32)}`, nonceLowerBound: '9', nonceQueryTag: '0x1f4',
    transactionHash: `0x${'55'.repeat(32)}`, failureReason: null, revision: '0', dispatchStartedAt: intent.createdAt,
    receiptObservation: { kind: 'settled', receiptBlockNumber: '501', receiptBlockHash: `0x${'77'.repeat(32)}`,
      finalizedBlockNumber: '510', finalizedBlockHash: `0x${'88'.repeat(32)}` },
    receiptCheckedAt: intent.createdAt, recoveryObservation: null, recoveryCheckedAt: null, assertion: null,
    createdAt: intent.createdAt, updatedAt: intent.createdAt }, responseEvidence: [],
    assertionConfirmation: 'I accept that retrying 0.5 BZZ may pay twice.' };
}

async function open(t, fixture) {
  const browser = await launchChrome(t, fixture.origin);
  await browser.call('Page.navigate', { url: `${fixture.origin}/dev/t09-intent-tests.html` });
  await waitFor(() => browser.evaluate("typeof document.querySelector('#run')?.onclick === 'function'"));
  await browser.evaluate(`(async () => {
    globalThis.api = (await import('/src/transfers/transferApi.ts')).transferApi;
    globalThis.intent = ${JSON.stringify(intent)};
    globalThis.signal = new AbortController().signal;
    return true;
  })()`);
  return browser;
}

test('fresh exact evidence bypasses a held older GET before authorizing pointer replacement', async t => {
  let held;
  let reads = 0;
  let posts = 0;
  const latest = detail();
  latest.responseEvidence = [{ transactionHash: `0x${'99'.repeat(32)}`, receivedAt: intent.createdAt, ownership: 'conflict' }];
  const fixture = await launchTransferFixture(t, (req, res) => {
    if (req.method === 'POST') posts++;
    if (req.url !== exactPath) return json(res, 404, {});
    reads++;
    if (reads === 1) { held = res; return; }
    json(res, 200, latest);
  });
  const browser = await open(t, fixture);
  await browser.evaluate(`(async () => {
    const { apiFetch } = await import('/src/http.ts');
    globalThis.older = apiFetch(${JSON.stringify(exactPath)}).then(response => response.json());
    const { IndexedDbTransferIntentStore } = await import('/src/transfers/transferIntentStore.ts');
    const { TransferController } = await import('/src/transfers/TransferController.ts');
    globalThis.store = new IndexedDbTransferIntentStore(indexedDB, 't09-http-held');
    await store.confirm(intent, null);
    globalThis.controller = new TransferController(store, api);
    controller.setContext(7, { name: intent.profileName, instanceId: intent.profileInstanceId });
    return true;
  })()`);
  await waitFor(() => reads === 1);
  const confirmation = browser.evaluate('controller.confirmNew({ direction: intent.direction, amountPlur: intent.amountPlur }, intent.requestId).then(() => true)');
  await waitFor(() => reads === 2, Boolean, 'a new exact HTTP request while the old request is still held');
  await confirmation;
  assert.equal((await browser.evaluate('controller.state')).issue, 'terminal_required');
  assert.equal(posts, 0);
  json(held, 200, detail());
  await browser.evaluate('older');
  assert.equal((await browser.evaluate('store.current(intent.accountId, intent.profileInstanceId)')).requestId, intent.requestId);
  assert.equal((await browser.evaluate('controller.state')).detail.responseEvidence[0].ownership, 'conflict');
  await browser.evaluate('controller.cancel(); store.close()');
  assert.deepEqual(browser.blockedRequests, []);
  assert.deepEqual(browser.errors, []);
});

test('adapter preserves exact request bodies and separates busy records, account refusal and response loss', async t => {
  let mode = 'success';
  const writes = [];
  const reads = [];
  const fixture = await launchTransferFixture(t, async (req, res) => {
    if (req.method === 'GET') {
      reads.push(req.url);
      if (mode === 'signed_out') return json(res, 401, {});
      if (mode === 'missing') return json(res, 404, {});
      if (req.url.startsWith('/profiles/')) return json(res, 200, { name: intent.profileName, instance_id: intent.profileInstanceId });
      return json(res, 200, detail());
    }
    writes.push({ path: req.url, body: await readJson(req), sameSite: req.headers['x-requested-with'] });
    if (mode === 'lost') { req.socket.destroy(); return; }
    if (mode === 'account') return json(res, 409, { error: 'account_changed', message: 'synthetic-private-upstream-diagnostic' });
    if (mode === 'target') return json(res, 409, { error: 'chequebook_profile_changed' });
    if (mode === 'busy') return json(res, 409, { ...detail(), kind: 'busy', operation: { ...detail().operation, requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } });
    if (mode === 'wrong_status') return json(res, 409, { ...detail(), kind: 'admitted' });
    return json(res, 202, { ...detail(), kind: 'admitted' });
  });
  const browser = await open(t, fixture);
  assert.deepEqual(await browser.evaluate('api.profile(intent.profileName, signal)'), { name: intent.profileName, instanceId: intent.profileInstanceId });
  assert.equal((await browser.evaluate('api.submit(intent, signal)')).operation.requestId, intent.requestId);
  assert.deepEqual(writes[0].body, { requestId: intent.requestId, profileInstanceId: intent.profileInstanceId, expectedAccountId: 7, amount: intent.amountPlur });
  assert.equal(writes[0].path, '/profiles/synthetic-test/chequebook/deposit');
  assert.equal(writes[0].sameSite, 'streaming-infra-manager');
  mode = 'busy';
  const busy = await browser.evaluate('api.submit(intent, signal)');
  assert.equal(busy.kind, 'busy');
  assert.notEqual(busy.operation.requestId, intent.requestId);
  for (const [next, reason] of [['account', 'account_changed'], ['target', 'target_changed'], ['lost', 'unavailable'], ['wrong_status', 'invalid_response']]) {
    mode = next;
    const result = await browser.evaluate('api.submit(intent, signal).then(() => null, error => ({ name: error.name, reason: error.reason, message: error.message }))');
    assert.equal(result.name, 'TransferApiError');
    assert.equal(result.reason, reason);
    assert.ok(!JSON.stringify(result).includes('synthetic-private'));
  }
  const writeCount = writes.length;
  mode = 'missing';
  assert.equal(await browser.evaluate('api.lookup(intent.requestId, signal)'), null);
  assert.equal(await browser.evaluate('api.lookup(intent.requestId, signal)'), null);
  assert.equal(writes.length, writeCount);
  mode = 'signed_out';
  assert.equal(await browser.evaluate('api.lookup(intent.requestId, signal).catch(error => error.name)'), 'SessionEndedError');
  assert.equal(reads.filter(path => path === exactPath).length, 3);
  assert.deepEqual(browser.blockedRequests, []);
  assert.deepEqual(browser.errors, []);
});
