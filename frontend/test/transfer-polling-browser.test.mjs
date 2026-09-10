/**
 * The operator watching a transfer they cannot hurry.
 *
 * The manager checks the chain on its own now, so the two surfaces that show a
 * submitted transfer have to reach the outcome without a click, and they have
 * to say when that automatic checking stops. Nothing here presses Check while
 * polling is running: a page that asked the chain itself would be checking the
 * same transaction twice.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RECEIPT_READ_INTERVAL_MS } from '@streaming-infra-manager/common';
import { createMockChequebookJournal } from '../dev/mock-chequebook.mjs';
import { launchHistoryFixture, historyInstanceId } from './support/history-fixture.mjs';
import { launchChrome, waitFor } from './support/chrome.mjs';
import { json, launchTransferFixture } from './support/transfer-fixture.mjs';

const instanceId = '11111111-1111-4111-8111-111111111111';
const profile = { name: 'synthetic-test', instance_id: instanceId, kind: 'streamer', status: 'RUNNING', containers: [],
  port_slot: 1, stamp_id: null, engine_settings: {}, has_engine_config: false, engine_config_error: null, engine_config_state: null,
  engine_config_revision: 0, intent_revision: 0, group_id: null, pendingStamp: false, stack_version_id: 1,
  created_at: '2026-09-08T00:00:00.000Z', updated_at: '2026-09-08T00:00:00.000Z' };
const receipt = { kind: 'settled', receiptBlockNumber: '501', receiptBlockHash: `0x${'77'.repeat(32)}`,
  finalizedBlockNumber: '510', finalizedBlockHash: `0x${'88'.repeat(32)}` };
const POLLED_SENTENCE = "The manager checks the chain for this transaction's receipt about every 20 seconds until";
const ENDED_SENTENCE = 'Automatic checks ended at';
/** One re-read plus room for a slow headless render, so a missed re-read fails instead of hanging. */
const WITHIN_ONE_REREAD_MS = RECEIPT_READ_INTERVAL_MS + 15_000;
/** A failed read may cost one cycle. It may not cost the cadence. */
const WITHIN_TWO_REREADS_MS = 2 * RECEIPT_READ_INTERVAL_MS + 15_000;

async function dialogFixture(t) {
  const dispatched = [];
  const reads = [];
  const posts = [];
  let readDelayMs = 0;
  let shouldFailNextRead = false;
  let override = null;
  const journal = createMockChequebookJournal({ profileFor: () => profile,
    nodeFor: () => ({ ethereum: `0x${'11'.repeat(20)}`, bzz: '20000000000000000', xdai: '1000000000000000',
      chequebook: { address: `0x${'22'.repeat(20)}`, total: '10000000000000000', available: '10000000000000000' } }),
    userFor: () => ({ id: 7 }), onSubmitted: operation => dispatched.push(operation) });
  const server = await launchTransferFixture(t, async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/profiles/synthetic-test') return json(res, 200, profile);
    if (req.method === 'GET' && path.startsWith('/chequebook/')) {
      reads.push(path);
      if (shouldFailNextRead) { shouldFailNextRead = false; return json(res, 503, { error: 'synthetic_unavailable' }); }
      const replacement = override?.(path);
      if (replacement) return json(res, replacement.status, replacement.body);
      if (readDelayMs > 0) await new Promise(resolve => setTimeout(resolve, readDelayMs));
    }
    if (req.method === 'POST') posts.push(path);
    for (const [method, pattern, handler] of journal.routes) {
      const match = pattern.exec(path);
      if (match && method === req.method) return handler(req, res, match.slice(1));
    }
    json(res, 404, {});
  });
  return { ...server, journal, dispatched, reads, posts,
    slowReads(milliseconds) { readDelayMs = milliseconds; },
    failNextRead() { shouldFailNextRead = true; },
    override(value) { override = value; } };
}

async function visible(browser, text, timeoutMs) {
  await waitFor(() => browser.evaluate(`document.body?.innerText.includes(${JSON.stringify(text)})`), Boolean, text, timeoutMs);
}
async function click(browser, text) {
  await waitFor(() => browser.evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)}); return !!button && !button.disabled; })()`), Boolean, `enabled ${text} button`);
  await browser.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)}).click()`);
}
async function amount(browser, value) {
  await waitFor(() => browser.evaluate("!!document.querySelector('[role=dialog] input') && !document.querySelector('[role=dialog] input').disabled"), Boolean, 'editable amount');
  await browser.evaluate(`(() => { const input = document.querySelector('[role="dialog"] input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}

test('the dialog reaches the settled outcome without a click while the manager polls', async t => {
  const h = await dialogFixture(t);
  const browser = await launchChrome(t, h.origin);
  await browser.call('Page.navigate', { url: `${h.origin}/dev/t09-dialog-tests.html` });
  await visible(browser, 'Storage and funding');
  await click(browser, 'Fill chequebook');
  await amount(browser, '0.5');
  await click(browser, 'Review transfer');
  await click(browser, 'Confirm transfer');
  await visible(browser, 'Waiting for transaction confirmation');
  await visible(browser, POLLED_SENTENCE);
  await visible(browser, 'This page re-reads the saved record every 10 seconds meanwhile.');
  assert.equal(h.dispatched.length, 1);
  assert.ok(h.dispatched[0].receiptPollUntil, 'a submitted record carries the manager deadline');
  const readsBefore = h.reads.length;
  h.journal.observeReceipt(h.dispatched[0].id, receipt);
  await visible(browser, 'Transfer verified on chain', WITHIN_ONE_REREAD_MS);
  assert.ok(h.reads.length > readsBefore, 'the dialog re-read the saved record on its own');
  assert.deepEqual(h.posts.filter(path => path.endsWith('/check')), []);
  assert.equal(await browser.evaluate(`document.body.innerText.includes(${JSON.stringify(POLLED_SENTENCE)})`), false);
  assert.deepEqual(browser.errors, []);
  assert.deepEqual(browser.blockedRequests, []);
});

async function detailPage(t, h, operationId) {
  const browser = await launchChrome(t, h.origin);
  await browser.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await browser.call('Page.navigate', { url: `${h.origin}/#/transfers/${operationId}` });
  await visible(browser, 'Saved transfer');
  return browser;
}

/** The seeded record with a chosen state and deadline, keeping every identity field the page compares. */
function shown(record, changes) {
  return { ...record, operation: { ...record.operation, ...changes } };
}

test('the transfer detail page reaches the settled outcome without a click while the manager polls', async t => {
  const h = await launchHistoryFixture(t, 1);
  const seeded = h.records[0];
  const record = h.journal.detail(seeded.id);
  const polling = shown(record, { state: 'submitted', receiptObservation: null, receiptCheckedAt: null,
    receiptPollUntil: new Date(Date.now() + 600_000).toISOString() });
  let answer = polling;
  h.override(url => url.pathname === `/chequebook/operations/${seeded.id}` ? { status: 200, body: answer } : null);
  const browser = await detailPage(t, h, seeded.id);
  await visible(browser, 'Waiting for transaction confirmation');
  await visible(browser, POLLED_SENTENCE);
  const readsBefore = h.reads.length;
  answer = record;
  await visible(browser, 'Transfer verified on chain', WITHIN_ONE_REREAD_MS);
  assert.ok(h.reads.length > readsBefore, 'the page re-read the saved record on its own');
  assert.deepEqual(h.posts, []);
  assert.equal(await browser.evaluate(`document.body.innerText.includes(${JSON.stringify(POLLED_SENTENCE)})`), false);
  assert.deepEqual(browser.errors, []);
});

test('a spent polling budget stops the re-reads, says so, and leaves Check to the operator', async t => {
  const h = await launchHistoryFixture(t, 1);
  const seeded = h.records[0];
  const record = h.journal.detail(seeded.id);
  const spent = shown(record, { state: 'submitted', receiptObservation: { kind: 'pending', reason: 'awaiting_receipt' },
    receiptCheckedAt: '2026-09-09T12:00:00.000Z', receiptPollUntil: '2026-09-09T12:30:00.000Z' });
  // The saved record only reaches its outcome once the operator asks the chain again.
  h.override(url => url.pathname === `/chequebook/operations/${seeded.id}` ? { status: 200, body: h.posts.length > 0 ? record : spent } : null);
  const browser = await detailPage(t, h, seeded.id);
  await visible(browser, ENDED_SENTENCE);
  await visible(browser, 'without a final receipt. Use Check to ask the chain again.');
  const settledReads = h.reads.filter(url => url.includes(seeded.id)).length;
  await new Promise(resolve => setTimeout(resolve, RECEIPT_READ_INTERVAL_MS + 3000));
  assert.equal(h.reads.filter(url => url.includes(seeded.id)).length, settledReads, 'a spent budget re-reads nothing');
  await click(browser, 'Check transaction receipt');
  await visible(browser, 'Transfer verified on chain');
  assert.deepEqual(h.posts, [`/chequebook/operations/${seeded.id}/check`]);
  assert.equal(await browser.evaluate(`document.body.innerText.includes(${JSON.stringify(ENDED_SENTENCE)})`), false);
  assert.deepEqual(browser.errors, []);
});

test('a conflicted transfer is never shown as polled and never re-read on its own', async t => {
  const h = await launchHistoryFixture(t, 1);
  const seeded = h.records[0];
  // The manager's due-row query excludes a conflict, so the page must not promise checks that never happen.
  const conflicted = shown(h.journal.detail(seeded.id), { state: 'submitted', failureReason: 'hash_conflict',
    receiptObservation: { kind: 'could_not_check', reason: 'attribution_conflict' }, receiptCheckedAt: '2026-09-09T12:00:00.000Z',
    receiptPollUntil: new Date(Date.now() + 600_000).toISOString() });
  h.override(url => url.pathname === `/chequebook/operations/${seeded.id}` ? { status: 200, body: conflicted } : null);
  const browser = await detailPage(t, h, seeded.id);
  await visible(browser, 'Transaction evidence needs review');
  const readsBefore = h.reads.filter(url => url.includes(seeded.id)).length;
  await new Promise(resolve => setTimeout(resolve, RECEIPT_READ_INTERVAL_MS + 3000));
  assert.equal(h.reads.filter(url => url.includes(seeded.id)).length, readsBefore, 'a conflicted transfer re-reads nothing');
  const body = await browser.evaluate('document.body.innerText');
  assert.equal(body.includes(POLLED_SENTENCE), false, 'no promise of automatic checks');
  assert.equal(body.includes(ENDED_SENTENCE), false, 'no claim that automatic checks ended');
  assert.equal(await browser.evaluate("[...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Check transaction receipt')"),
    false, 'a conflicted transfer offers no Check button to point the operator at');
  assert.deepEqual(h.posts, []);
  assert.deepEqual(browser.errors, []);
});

const UNKNOWN_SENTENCE = 'The manager has not returned a verified record for this request. Its transaction outcome is unknown.';

/** Every rendered state, not a sample of them, so a flash of one frame still counts. */
async function watchForText(browser, text) {
  await browser.evaluate(`(() => {
    globalThis.__t09Seen = 0;
    const look = () => { if (document.body.innerText.includes(${JSON.stringify(text)})) globalThis.__t09Seen++; };
    look();
    globalThis.__t09Watch = new MutationObserver(look);
    globalThis.__t09Watch.observe(document.body, { childList: true, subtree: true, characterData: true });
  })()`);
  return async () => {
    const seen = await browser.evaluate('globalThis.__t09Seen');
    await browser.evaluate('globalThis.__t09Watch.disconnect()');
    return seen;
  };
}

test('an automatic re-read never tells the operator the outcome is unknown', async t => {
  const h = await dialogFixture(t);
  h.slowReads(400);
  const browser = await launchChrome(t, h.origin);
  await browser.call('Page.navigate', { url: `${h.origin}/dev/t09-dialog-tests.html` });
  await visible(browser, 'Storage and funding');
  await click(browser, 'Fill chequebook');
  await amount(browser, '0.5');
  await click(browser, 'Review transfer');
  await click(browser, 'Confirm transfer');
  await visible(browser, 'Waiting for transaction confirmation');
  await visible(browser, POLLED_SENTENCE);
  const seen = await watchForText(browser, UNKNOWN_SENTENCE);
  const readsBefore = h.reads.length;
  await new Promise(resolve => setTimeout(resolve, RECEIPT_READ_INTERVAL_MS + 4000));
  assert.ok(h.reads.length > readsBefore, 'the dialog re-read the saved record during the sampled window');
  assert.equal(await seen(), 0, 'the evidence panel is never replaced by the unknown-outcome sentence while the record is submitted');
  assert.equal(await browser.evaluate(`document.body.innerText.includes(${JSON.stringify(POLLED_SENTENCE)})`), true);
  assert.deepEqual(h.posts.filter(path => path.endsWith('/check')), []);
  assert.deepEqual(browser.errors, []);
});

test('one failed re-read costs the dialog a cycle and not the cadence', async t => {
  const h = await dialogFixture(t);
  const browser = await launchChrome(t, h.origin);
  await browser.call('Page.navigate', { url: `${h.origin}/dev/t09-dialog-tests.html` });
  await visible(browser, 'Storage and funding');
  await click(browser, 'Fill chequebook');
  await amount(browser, '0.5');
  await click(browser, 'Review transfer');
  await click(browser, 'Confirm transfer');
  await visible(browser, POLLED_SENTENCE);
  h.failNextRead();
  await visible(browser, 'The saved transfer could not be checked.', WITHIN_ONE_REREAD_MS);
  h.journal.observeReceipt(h.dispatched[0].id, receipt);
  await visible(browser, 'Transfer verified on chain', WITHIN_TWO_REREADS_MS);
  assert.deepEqual(h.posts.filter(path => path.endsWith('/check')), []);
  assert.deepEqual(browser.errors, []);
});

test('one failed re-read costs the detail page a cycle and not the cadence', async t => {
  const h = await launchHistoryFixture(t, 1);
  const seeded = h.records[0];
  const record = h.journal.detail(seeded.id);
  let answer = shown(record, { state: 'submitted', receiptObservation: null, receiptCheckedAt: null,
    receiptPollUntil: new Date(Date.now() + 600_000).toISOString() });
  let failNext = false;
  h.override(url => {
    if (url.pathname !== `/chequebook/operations/${seeded.id}`) return null;
    if (failNext) { failNext = false; return { status: 503, body: { error: 'synthetic_unavailable' } }; }
    return { status: 200, body: answer };
  });
  const browser = await detailPage(t, h, seeded.id);
  await visible(browser, POLLED_SENTENCE);
  failNext = true;
  await visible(browser, 'Saved transfer evidence could not be verified', WITHIN_ONE_REREAD_MS);
  answer = record;
  await visible(browser, 'Transfer verified on chain', WITHIN_TWO_REREADS_MS);
  assert.deepEqual(h.posts, []);
  assert.deepEqual(browser.errors, []);
});

test('a spent polling budget stops the dialog re-reads and says so', async t => {
  const h = await dialogFixture(t);
  const browser = await launchChrome(t, h.origin);
  await browser.call('Page.navigate', { url: `${h.origin}/dev/t09-dialog-tests.html` });
  await visible(browser, 'Storage and funding');
  await click(browser, 'Fill chequebook');
  await amount(browser, '0.5');
  await click(browser, 'Review transfer');
  await click(browser, 'Confirm transfer');
  await visible(browser, POLLED_SENTENCE);
  const spent = shown(h.journal.detail(h.dispatched[0].id), { receiptObservation: { kind: 'pending', reason: 'awaiting_receipt' },
    receiptCheckedAt: '2026-09-09T12:00:00.000Z', receiptPollUntil: '2026-09-09T12:30:00.000Z' });
  h.override(path => path.endsWith(`/by-request/${h.dispatched[0].requestId}`) ? { status: 200, body: spent } : null);
  await click(browser, 'Refresh saved status');
  await visible(browser, ENDED_SENTENCE);
  const readsBefore = h.reads.length;
  await new Promise(resolve => setTimeout(resolve, RECEIPT_READ_INTERVAL_MS + 3000));
  assert.equal(h.reads.length, readsBefore, 'a spent budget re-reads nothing');
  await visible(browser, 'Waiting for transaction confirmation');
  assert.deepEqual(h.posts.filter(path => path.endsWith('/check')), []);
  assert.deepEqual(browser.errors, []);
});
