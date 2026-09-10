import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMockChequebookJournal } from '../dev/mock-chequebook.mjs';
import { buttonWithText, clickWhenEnabled, createProtocolClient, fillWhenPresent, launchChrome, pageShows, readWhenPresent, throttleCpu, waitFor } from './support/chrome.mjs';
import { json, launchTransferFixture } from './support/transfer-fixture.mjs';

const instanceId = '11111111-1111-4111-8111-111111111111';
const initialProfile = { name: 'synthetic-test', instance_id: instanceId, kind: 'streamer', status: 'RUNNING', containers: [],
  port_slot: 1, stamp_id: null, engine_settings: {}, has_engine_config: false, engine_config_error: null, engine_config_state: null,
  engine_config_revision: 0, intent_revision: 0, group_id: null, pendingStamp: false, stack_version_id: 1,
  created_at: '2026-09-08T00:00:00.000Z', updated_at: '2026-09-08T00:00:00.000Z' };
const receipt = { kind: 'settled', receiptBlockNumber: '501', receiptBlockHash: `0x${'77'.repeat(32)}`,
  finalizedBlockNumber: '510', finalizedBlockHash: `0x${'88'.repeat(32)}` };

async function fixture(t, { unknown = false } = {}) {
  let profile = { ...initialProfile };
  let user = { id: 7 };
  let dropResponse = false;
  let missing = false;
  let view = null;
  const dispatched = [];
  const posts = [];
  const journal = createMockChequebookJournal({ profileFor: () => profile,
    nodeFor: () => ({ ethereum: `0x${'11'.repeat(20)}`, bzz: '20000000000000000', xdai: '1000000000000000',
      chequebook: { address: `0x${'22'.repeat(20)}`, total: '10000000000000000', available: '10000000000000000' } }),
    userFor: () => user, onSubmitted: operation => dispatched.push(operation), ...(unknown ? { responseFor: () => null } : {}) });
  const server = await launchTransferFixture(t, async (req, res) => {
    if (!user) return json(res, 401, {});
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/profiles/synthetic-test') return json(res, profile ? 200 : 404, profile ?? {});
    if (req.method === 'GET' && path.startsWith('/chequebook/') && missing) return json(res, 404, {});
    if (req.method === 'GET' && path.startsWith('/chequebook/') && view) {
      const operation = dispatched.find(operation => path.endsWith(operation.requestId) || path.endsWith(operation.id));
      if (operation) return json(res, 200, view(journal.detail(operation.id)));
    }
    if (req.method === 'POST') {
      posts.push(path);
      if (dropResponse) {
        const end = res.end.bind(res);
        res.end = (...args) => { req.socket.destroy(); return end(...args); };
      }
    }
    for (const [method, pattern, handler] of journal.routes) {
      const match = pattern.exec(path);
      if (match && method === req.method) return handler(req, res, match.slice(1));
    }
    json(res, 404, {});
  });
  return { ...server, journal, dispatched, posts, account(id) { user = id === null ? null : { id }; },
    replace() { profile = { ...profile, instance_id: randomUUID() }; return profile; }, remove() { profile = null; },
    view(transform) { view = transform; },
    drop(value) { dropResponse = value; }, missing(value) { missing = value; } };
}

async function open(t, fixture, script) {
  const browser = await launchChrome(t, fixture.origin);
  if (script) await browser.call('Page.addScriptToEvaluateOnNewDocument', { source: script });
  await browser.call('Page.navigate', { url: `${fixture.origin}/dev/t09-dialog-tests.html` });
  await waitFor(() => browser.evaluate(pageShows('Storage and funding')), Boolean, 'the dialog fixture page to render');
  return browser;
}
const DIALOG = `document.querySelector('[role="dialog"]')`;
const DIALOG_AMOUNT = `document.querySelector('[role="dialog"] input')`;
const click = (browser, text) => clickWhenEnabled(browser.evaluate, buttonWithText(text), `an enabled ${text} button`);
const visible = (browser, text) => waitFor(() => browser.evaluate(pageShows(text)), Boolean, text);
const amount = (browser, value) => fillWhenPresent(browser.evaluate, DIALOG_AMOUNT, value, 'the editable amount');

async function anotherDialog(t, first, origin) {
  const { targetId } = await first.call('Target.createTarget', { url: 'about:blank', background: true });
  const tabs = await fetch(`http://127.0.0.1:${first.debuggingPort}/json/list`, { signal: AbortSignal.timeout(5000) }).then(response => response.json());
  const socket = new WebSocket(tabs.find(tab => tab.id === targetId).webSocketDebuggerUrl);
  t.after(() => socket.close());
  await once(socket, 'open', { signal: AbortSignal.timeout(5000) });
  const { call } = createProtocolClient(socket);
  const blocked = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = message.params;
    const allowed = new URL(request.url).origin === origin;
    if (!allowed) blocked.push(request.url);
    void call(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId } : { requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
  });
  await call('Runtime.enable'); await call('Page.enable');
  await call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await throttleCpu(call);
  const browser = { call, async evaluate(expression) {
    const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.equal(response.exceptionDetails, undefined, JSON.stringify(response.exceptionDetails));
    return response.result.value;
  } };
  t.after(() => assert.deepEqual(blocked, []));
  await call('Page.navigate', { url: `${origin}/dev/t09-dialog-tests.html` });
  await visible(browser, 'Storage and funding');
  return browser;
}
async function review(browser, value = '0.5') {
  await visible(browser, 'Amount (BZZ)');
  await amount(browser, value);
  await click(browser, 'Review transfer');
  await visible(browser, 'Confirm transfer');
}
async function confirm(browser, value = '0.5') {
  await review(browser, value);
  await click(browser, 'Confirm transfer');
}
async function screenshot(browser, fixture, name, width) {
  await browser.call('Emulation.setDeviceMetricsOverride', { width, height: width < 500 ? 844 : 1000, deviceScaleFactor: 1, mobile: width < 500 });
  await waitFor(() => browser.evaluate(`(() => {
    const container = document.querySelector('.MuiDialog-container');
    return !!container && getComputedStyle(container).opacity === '1';
  })()`), Boolean, 'completed dialog transition');
  await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(await waitFor(() => browser.evaluate(`(() => {
    const dialog = ${DIALOG};
    return dialog && dialog.scrollWidth <= dialog.clientWidth;
  })()`), value => value !== null, 'the open dialog to measure'), true, 'Dialog must not overflow horizontally');
  const { data } = await browser.call('Page.captureScreenshot', { format: 'png' });
  const path = join(fixture.evidence, `${name}-${width}.png`);
  await writeFile(path, Buffer.from(data, 'base64'));
  return path;
}

test('actual dialog restores an unknown saved intent after balance failure, opposite direction and reload', async t => {
  const h = await fixture(t, { unknown: true });
  const browser = await open(t, h);
  await click(browser, 'Fill chequebook');
  await confirm(browser);
  await visible(browser, 'Submission outcome unknown');
  assert.equal(h.dispatched.length, 1);
  const id = h.dispatched[0].requestId;
  await visible(browser, id);
  await browser.evaluate('t09Ui.balances(false)');
  await visible(browser, 'Submission outcome unknown');
  assert.equal(await browser.evaluate("document.querySelectorAll('[role=dialog]').length"), 1);
  t.diagnostic(await screenshot(browser, h, 'saved-unknown', 1280));
  t.diagnostic(await screenshot(browser, h, 'saved-unknown', 390));
  await click(browser, 'Close');
  await click(browser, 'Saved transfer');
  await visible(browser, id);
  await click(browser, 'Close');
  await browser.evaluate('t09Ui.balances(true)');
  await click(browser, 'Withdraw');
  await visible(browser, 'Saved fill to chequebook');
  await visible(browser, id);
  await browser.call('Page.reload');
  await visible(browser, 'Storage and funding');
  await click(browser, 'Saved transfer');
  await visible(browser, id);
  assert.equal(h.posts.length, 1);
  assert.deepEqual(browser.errors, []);
  assert.deepEqual(browser.blockedRequests, []);
});

test('lost HTTP response and missing lookup retain one UUID until an explicit identical-request retry', async t => {
  const h = await fixture(t, { unknown: true });
  h.drop(true); h.missing(true);
  const browser = await open(t, h);
  await click(browser, 'Fill chequebook');
  await confirm(browser);
  await visible(browser, 'The submission response was lost');
  const id = h.dispatched[0].requestId;
  await click(browser, 'Refresh saved status');
  await visible(browser, 'No record was returned for this saved request');
  assert.equal(h.posts.length, 1);
  h.drop(false);
  await click(browser, 'Retry this saved request');
  await visible(browser, 'Send the same request again');
  await click(browser, 'Send the same request again');
  await visible(browser, 'Submission outcome unknown');
  assert.equal(h.posts.length, 2);
  assert.equal(h.dispatched.length, 1);
  await visible(browser, id);
});

test('new transfers require explicit confirmation and harmless rerenders preserve amount edits', async t => {
  const h = await fixture(t);
  const browser = await open(t, h);
  await click(browser, 'Fill chequebook');
  await visible(browser, 'Amount (BZZ)');
  await amount(browser, '0.4');
  await browser.evaluate('t09Ui.refresh()');
  assert.equal(await readWhenPresent(browser.evaluate, DIALOG_AMOUNT, 'value', 'the amount the dialog kept'), '0.4');
  await click(browser, 'Review transfer');
  await click(browser, 'Confirm transfer');
  await visible(browser, 'Waiting for transaction confirmation');
  h.journal.observeReceipt(h.dispatched[0].id, receipt);
  await click(browser, 'Refresh saved status');
  await visible(browser, 'Transfer verified on chain');
  assert.equal(await browser.evaluate("document.querySelectorAll('[role=dialog]').length"), 1);
  await click(browser, 'New transfer');
  assert.equal(h.dispatched.length, 1);
  await confirm(browser, '0.2');
  await visible(browser, 'Waiting for transaction confirmation');
  assert.equal(h.dispatched.length, 2);
  assert.notEqual(h.dispatched[0].requestId, h.dispatched[1].requestId);
});

test('busy conflict evidence is shown separately from the immutable saved intent', async t => {
  const h = await fixture(t);
  const input = { requestId: randomUUID(), profileInstanceId: instanceId, expectedAccountId: 7, amount: '1000000000000000' };
  const response = await fetch(`${h.origin}/profiles/synthetic-test/chequebook/deposit`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const old = await response.json();
  h.journal.observeReceipt(old.operation.id, receipt);
  h.journal.observeResponse(old.operation.id, `0x${'99'.repeat(32)}`);
  const browser = await open(t, h);
  await click(browser, 'Fill chequebook');
  await confirm(browser);
  await visible(browser, 'Another transfer blocks this node');
  await visible(browser, 'Transaction evidence needs review');
  await visible(browser, input.requestId);
  const saved = await browser.evaluate(`(async () => { const { IndexedDbTransferIntentStore } = await import('/src/transfers/transferIntentStore.ts');
    const store = new IndexedDbTransferIntentStore(indexedDB); const intent = await store.current(7, ${JSON.stringify(instanceId)}); await store.close(); return intent; })()`);
  assert.notEqual(saved.requestId, input.requestId);
  await visible(browser, saved.requestId);
  assert.equal(h.dispatched.length, 1);
  t.diagnostic(await screenshot(browser, h, 'blocking-conflict', 1280));
  t.diagnostic(await screenshot(browser, h, 'blocking-conflict', 390));
  await waitFor(() => browser.evaluate(`(() => {
    const content = document.querySelector('.MuiDialogContent-root');
    if (!content) return false;
    content.scrollTop = content.scrollHeight;
    return true;
  })()`), Boolean, 'the dialog content to scroll to its end');
  t.diagnostic(await screenshot(browser, h, 'blocking-conflict-details', 390));
});

test('storage refusal and account or profile changes prevent stale confirmation', async t => {
  const h = await fixture(t);
  const blocked = await open(t, h, "IDBFactory.prototype.open = function () { throw new Error('Synthetic storage refusal'); };");
  await blocked.evaluate('t09Ui.balances(false)');
  await click(blocked, 'Saved transfer');
  await visible(blocked, 'This browser could not safely read or save the transfer');
  assert.equal(h.posts.length, 0);
  const browser = await open(t, h);
  await click(browser, 'Fill chequebook');
  await review(browser);
  await browser.evaluate('t09Ui.account(null)');
  await visible(browser, 'Sign in to continue');
  assert.equal(h.posts.length, 0);
  await browser.evaluate('t09Ui.account(7)');
  await review(browser);
  h.account(8);
  await click(browser, 'Confirm transfer');
  await visible(browser, 'The signed-in account changed');
  assert.equal(h.dispatched.length, 0);
  h.account(7);
  await click(browser, 'Close');
  const replacement = h.replace();
  await browser.evaluate(`t09Ui.profile(${JSON.stringify(replacement)})`);
  await click(browser, 'Fill chequebook');
  await review(browser);
  h.replace();
  await click(browser, 'Confirm transfer');
  await visible(browser, 'The deployment was removed or replaced');
  assert.equal(h.dispatched.length, 0);
});

test('a stale reviewed confirmation restores the other tab’s new terminal request without submitting C', async t => {
  const h = await fixture(t);
  const first = await open(t, h);
  await click(first, 'Fill chequebook'); await confirm(first);
  await visible(first, 'Waiting for transaction confirmation');
  h.journal.observeReceipt(h.dispatched[0].id, receipt);
  await click(first, 'Refresh saved status');
  await visible(first, 'Transfer verified on chain');
  await click(first, 'New transfer');
  await review(first, '0.4');

  const second = await anotherDialog(t, first, h.origin);
  await click(second, 'Saved transfer');
  await visible(second, 'Transfer verified on chain');
  await click(second, 'New transfer'); await confirm(second, '0.3');
  await visible(second, 'Waiting for transaction confirmation');
  assert.equal(h.dispatched.length, 2);
  const b = h.dispatched[1];
  h.journal.observeReceipt(b.id, receipt);
  await click(second, 'Refresh saved status');
  await visible(second, 'Transfer verified on chain');

  await click(first, 'Confirm transfer');
  await visible(first, b.requestId);
  await visible(first, 'Transfer verified on chain');
  assert.equal(h.dispatched.length, 2);
  assert.equal(h.posts.length, 2);
});

test('receipt and recovery check times stay distinct', async t => {
  const h = await fixture(t);
  const browser = await open(t, h);
  await click(browser, 'Fill chequebook'); await confirm(browser);
  await visible(browser, 'Waiting for transaction confirmation');
  h.view(detail => ({ ...detail, operation: { ...detail.operation,
    receiptObservation: { kind: 'pending', reason: 'awaiting_finality' }, receiptCheckedAt: '2026-09-08T10:00:00.000Z',
    recoveryObservation: { kind: 'could_not_check', reason: 'rpc_unavailable', candidateHashes: [] }, recoveryCheckedAt: '2026-09-08T11:00:00.000Z' } }));
  await click(browser, 'Refresh saved status');
  await visible(browser, 'Last receipt check'); await visible(browser, '2026-09-08T10:00:00.000Z');
  await visible(browser, 'Last recovery check'); await visible(browser, '2026-09-08T11:00:00.000Z');
  assert.equal(h.posts.length, 1);
});

test('returned identity conflicts stay distinct through a missing lookup without permitting another send', async t => {
  const h = await fixture(t);
  const browser = await open(t, h);
  await click(browser, 'Fill chequebook'); await confirm(browser);
  await visible(browser, 'Waiting for transaction confirmation');
  h.journal.observeReceipt(h.dispatched[0].id, receipt);
  h.view(detail => ({ ...detail, operation: { ...detail.operation, nodeAddress: `0x${'66'.repeat(20)}` } }));
  await click(browser, 'Refresh saved status');
  await visible(browser, 'Conflicting returned evidence');
  await visible(browser, 'Returned node');
  assert.equal(await browser.evaluate(pageShows('Another transfer blocks this node')), false);
  assert.equal(await browser.evaluate(pageShows('Transfer verified on chain')), false);
  assert.equal(await browser.evaluate("[...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'New transfer')"), false);
  await visible(browser, h.dispatched[0].requestId);
  t.diagnostic(await screenshot(browser, h, 'returned-identity-conflict', 1280));
  t.diagnostic(await screenshot(browser, h, 'returned-identity-conflict', 390));

  h.missing(true);
  await click(browser, 'Refresh saved status');
  await visible(browser, 'No record was returned for this saved request');
  await visible(browser, 'Conflicting returned evidence');
  assert.equal(await browser.evaluate("[...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Retry this saved request' || button.textContent.trim() === 'New transfer')"), false);
  assert.equal(h.posts.length, 1);

  h.missing(false); h.view(null);
  await click(browser, 'Refresh saved status');
  await visible(browser, 'Transfer verified on chain');
  assert.equal(await browser.evaluate(pageShows('Conflicting returned evidence')), false);
  assert.equal(h.posts.length, 1);
});

test('a busy saved request can explicitly retry its same ID after the blocking transfer settles', async t => {
  const h = await fixture(t);
  const response = await fetch(`${h.origin}/profiles/synthetic-test/chequebook/deposit`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), profileInstanceId: instanceId, expectedAccountId: 7, amount: '1000000000000000' }) });
  const a = await response.json();
  const browser = await open(t, h);
  await click(browser, 'Fill chequebook'); await confirm(browser);
  await visible(browser, 'Another transfer blocks this node');
  const saved = await browser.evaluate(`(async () => { const { IndexedDbTransferIntentStore } = await import('/src/transfers/transferIntentStore.ts');
    const store = new IndexedDbTransferIntentStore(indexedDB); const intent = await store.current(7, ${JSON.stringify(instanceId)}); await store.close(); return intent; })()`);
  assert.notEqual(saved.requestId, a.operation.requestId);
  h.journal.observeReceipt(a.operation.id, receipt);
  await click(browser, 'Refresh saved status');
  await visible(browser, 'No record was returned for this saved request');
  await visible(browser, 'Previously returned blocking operation');
  assert.equal(await browser.evaluate(pageShows('Another transfer blocks this node')), false);
  assert.equal(h.dispatched.length, 1);
  await click(browser, 'Retry this saved request');
  await click(browser, 'Send the same request again');
  await waitFor(() => h.dispatched.length, value => value === 2, 'admitted exact retry');
  await visible(browser, 'Waiting for transaction confirmation');
  assert.equal(h.dispatched.length, 2);
  assert.equal(h.dispatched[1].requestId, saved.requestId);
  assert.equal(h.posts.length, 3);
  assert.equal(await browser.evaluate(pageShows('Another transfer blocks this node')), false);
});

test('controller keeps the busy and identity-conflict retry boundaries distinct', async t => {
  const h = await fixture(t);
  const browser = await open(t, h);
  const result = await browser.evaluate("(async () => { const { runControllerTests } = await import('/dev/t09-controller-tests.ts'); return runControllerTests(); })()");
  assert.equal(result.passed, 11);
  assert.deepEqual(browser.errors, []);
  assert.deepEqual(browser.blockedRequests, []);
});
