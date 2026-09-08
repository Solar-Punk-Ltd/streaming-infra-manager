import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMockChequebookJournal } from '../dev/mock-chequebook.mjs';
import { launchChrome, waitFor } from './support/chrome.mjs';
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
    drop(value) { dropResponse = value; }, missing(value) { missing = value; } };
}

async function open(t, fixture, script) {
  const browser = await launchChrome(t, fixture.origin);
  if (script) await browser.call('Page.addScriptToEvaluateOnNewDocument', { source: script });
  await browser.call('Page.navigate', { url: `${fixture.origin}/dev/t09-dialog-tests.html` });
  await waitFor(() => browser.evaluate("document.body.innerText.includes('Storage and funding')"));
  return browser;
}
async function click(browser, text) {
  await browser.evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)});
    if (!button || button.disabled) throw new Error('Button is unavailable: ' + ${JSON.stringify(text)}); button.click(); })()`);
}
async function visible(browser, text) {
  await waitFor(() => browser.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`), Boolean, text);
}
async function amount(browser, value) {
  await browser.evaluate(`(() => { const input = document.querySelector('[role="dialog"] input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
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
  assert.equal(await browser.evaluate("document.querySelector('[role=dialog] input').value"), '0.4');
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
