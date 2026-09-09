import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchHistoryFixture, historyInstanceId } from './support/history-fixture.mjs';
import { launchChrome, waitFor } from './support/chrome.mjs';
import { json, launchTransferFixture } from './support/transfer-fixture.mjs';

test('account-scoped browser history continues beyond500 foreign records without changing pointers', async t => {
  const fixture = await launchTransferFixture(t, (_req, res) => json(res, 404, {}));
  const browser = await launchChrome(t, fixture.origin);
  await browser.call('Page.navigate', { url: `${fixture.origin}/dev/t09-intent-tests.html` });
  const result = await browser.evaluate("(async () => { const { runHistoryStoreTests } = await import('/dev/t09-history-store-tests.ts'); return runHistoryStoreTests(); })()");
  assert.equal(result.passed, 1);
  assert.deepEqual(browser.errors, []);
  assert.deepEqual(browser.blockedRequests, []);
});

async function visible(browser, text) {
  await waitFor(() => browser.evaluate(`document.body?.innerText.includes(${JSON.stringify(text)})`), Boolean, text);
}
async function click(browser, text) {
  await waitFor(() => browser.evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)}); return !!button && !button.disabled; })()`), Boolean, text);
  await browser.evaluate(`([...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)})).click()`);
}
async function route(browser, path) { await browser.evaluate(`window.location.hash = ${JSON.stringify(path)}`); }
async function capture(browser, fixture, name, width) {
  await browser.call('Emulation.setDeviceMetricsOverride', { width, height: width < 500 ? 844 : 1000, deviceScaleFactor: 1, mobile: width < 500 });
  await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'History must not overflow horizontally');
  const { data } = await browser.call('Page.captureScreenshot', { format: 'png' });
  const path = join(fixture.evidence, `${name}-${width}.png`);
  await writeFile(path, Buffer.from(data, 'base64'));
  return path;
}
async function app(t, fixture, path = '#/transfers') {
  const browser = await launchChrome(t, fixture.origin);
  await browser.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await browser.call('Page.addScriptToEvaluateOnNewDocument', { source: "globalThis.historyFixtureErrors = []; addEventListener('error', event => historyFixtureErrors.push(event.message)); addEventListener('unhandledrejection', event => historyFixtureErrors.push(String(event.reason)));" });
  await browser.call('Page.navigate', { url: `${fixture.origin}/${path}` });
  try { await visible(browser, 'operator-7'); }
  catch (error) { t.diagnostic(JSON.stringify(await browser.evaluate('({ errors: historyFixtureErrors, text: document.body.innerText })'))); throw error; }
  return browser;
}

test('global history survives failed deployment reads and separates pagination failures from empty history', async t => {
  const h = await launchHistoryFixture(t, 26);
  const browser = await app(t, h);
  await visible(browser, 'Transfer history');
  await visible(browser, 'Could not read the deployments');
  await visible(browser, 'Saved status: settled');
  assert.equal(await browser.evaluate("document.body?.innerText.includes('Transfer verified on chain')"), false);
  t.diagnostic(await capture(browser, h, 'transfer-history', 1280));
  t.diagnostic(await capture(browser, h, 'transfer-history', 390));
  h.override(url => url.searchParams.has('cursor') ? { status: 503, body: { diagnostic: 'synthetic-private-upstream' } } : null);
  await click(browser, 'Older transfers');
  await visible(browser, 'Transfer history could not be read');
  assert.equal(await browser.evaluate("document.body?.innerText.includes('No transfers have been recorded') || document.body?.innerText.includes('synthetic-private-upstream')"), false);
  h.override(url => url.searchParams.has('cursor') ? { status: 200, body: { operations: null, nextCursor: null } } : null);
  await click(browser, 'Retry history');
  await visible(browser, 'The transfer history response could not be verified');
  h.override(null);
  await click(browser, 'Retry history');
  await visible(browser, 'Saved status: settled');
  const links = await browser.evaluate("[...document.querySelectorAll('a')].map(link => link.getAttribute('href')).filter(href => href?.startsWith('#/transfers/'))");
  assert.equal(links.length, 1);
  await route(browser, links[0]);
  await visible(browser, 'Transfer verified on chain');
  await visible(browser, 'removed-profile');
  await visible(browser, 'Saved node');
  t.diagnostic(await capture(browser, h, 'transfer-detail', 1280));
  t.diagnostic(await capture(browser, h, 'transfer-detail', 390));
  assert.deepEqual(h.posts, []);
  assert.deepEqual(browser.errors, []);
});

test('a browser-only request stays discoverable after profile deletion and404 without any resubmission', async t => {
  const h = await launchHistoryFixture(t);
  const browser = await launchChrome(t, h.origin);
  await browser.call('Page.navigate', { url: `${h.origin}/dev/t09-intent-tests.html` });
  const ids = await browser.evaluate(`(async () => { const { IndexedDbTransferIntentStore } = await import('/src/transfers/transferIntentStore.ts');
    const store = new IndexedDbTransferIntentStore(indexedDB); const ids = [];
    for (const accountId of [7, 8]) { const input = { requestId: crypto.randomUUID(), accountId, profileName: 'removed-local-profile',
      profileInstanceId: ${JSON.stringify(historyInstanceId)}, direction: 'withdraw', amountPlur: '2500000000000000', createdAt: '2026-09-08T01:02:03.000Z' };
      await store.confirm(input, null); ids.push(input.requestId); } await store.close(); return ids; })()`);
  await browser.call('Page.navigate', { url: `${h.origin}/#/transfers` });
  await visible(browser, 'No transfers have been recorded');
  await visible(browser, 'Saved on this browser');
  await visible(browser, ids[0]);
  await visible(browser, '2026-09-08T01:02:03.000Z');
  assert.equal(await browser.evaluate(`document.body?.innerText.includes(${JSON.stringify(ids[1])})`), false);
  await route(browser, `#/transfers/request/${ids[0]}`);
  await visible(browser, 'No manager record was returned for this request');
  await visible(browser, ids[0]);
  await visible(browser, '0.25 BZZ');
  assert.equal(await browser.evaluate("[...document.querySelectorAll('button')].some(button => /retry.*request|send|new transfer/i.test(button.textContent))"), false);
  await browser.call('Page.reload');
  await visible(browser, ids[0]);
  await visible(browser, 'No manager record was returned for this request');
  assert.ok(h.reads.some(path => path.includes(`/by-request/${ids[0]}`)));
  assert.deepEqual(h.posts, []);
});

test('a late operation detail cannot replace a different route or contradict its immutable identity', async t => {
  const h = await launchHistoryFixture(t, 2);
  const [a, b] = h.records;
  const held = h.holdOnce(a.id);
  const browser = await app(t, h, `#/transfers/${a.id}`);
  await waitFor(() => h.reads.some(path => path.endsWith(held.id)), Boolean, 'held detail request');
  await held.entered;
  await route(browser, `#/transfers/${b.id}`);
  await visible(browser, b.requestId);
  held.release();
  await browser.evaluate('new Promise(resolve => setTimeout(resolve, 100))');
  assert.equal(await browser.evaluate(`document.body?.innerText.includes(${JSON.stringify(a.requestId)})`), false);
  h.override(url => url.pathname.endsWith(b.id) ? { status: 200, body: h.journal.detail(a.id) } : null);
  await click(browser, 'Refresh saved evidence');
  await visible(browser, 'Returned details do not match this saved transfer');
  assert.equal(await browser.evaluate("document.body?.innerText.includes('Transfer verified on chain')"), false);
  h.override(null);
  await click(browser, 'Refresh saved evidence');
  await visible(browser, 'Transfer verified on chain');
  const changedNode = structuredClone(h.journal.detail(b.id));
  changedNode.operation.nodeAddress = `0x${'aa'.repeat(20)}`;
  h.override(url => url.pathname.endsWith(b.id) ? { status: 200, body: changedNode } : null);
  await click(browser, 'Refresh saved evidence');
  await visible(browser, 'Returned details do not match this saved transfer');
  assert.equal(await browser.evaluate("document.body?.innerText.includes('Transfer verified on chain')"), false);
  assert.deepEqual(h.posts, []);
});

test('a detail response from the previous authenticated account cannot hide newer conflict evidence', async t => {
  const h = await launchHistoryFixture(t, 1);
  const operation = h.records[0];
  const held = h.holdOnce(operation.id);
  const browser = await app(t, h, `#/transfers/${operation.id}`);
  await waitFor(() => h.reads.some(path => path.endsWith(held.id)), Boolean, 'held detail request');
  await held.entered;
  await click(browser, 'Sign out');
  await visible(browser, 'Sign in to the manager');
  h.journal.observeResponse(operation.id, `0x${'99'.repeat(32)}`);
  await browser.evaluate(`for (const [name, value] of [['username', 'operator-8'], ['password', 'synthetic-test-password']]) {
    const input = document.querySelector('input[name=' + name + ']'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }`);
  await click(browser, 'Sign in');
  await visible(browser, 'operator-8');
  await visible(browser, 'Transaction evidence needs review');
  held.release();
  await browser.evaluate('new Promise(resolve => setTimeout(resolve, 100))');
  assert.equal(await browser.evaluate("document.body?.innerText.includes('Transfer verified on chain')"), false);
  await visible(browser, `0x${'99'.repeat(32)}`);
  assert.deepEqual(h.posts, []);
});

test('the browser list offers continuation after a page containing only another account', async t => {
  const h = await launchHistoryFixture(t);
  const browser = await launchChrome(t, h.origin);
  await browser.call('Page.navigate', { url: `${h.origin}/dev/t09-intent-tests.html` });
  const requestId = await browser.evaluate(`(async () => { const { IndexedDbTransferIntentStore } = await import('/src/transfers/transferIntentStore.ts');
    const store = new IndexedDbTransferIntentStore(indexedDB); let previous = null; let own;
    for (let number = 1; number <= 501; number++) { const requestId = '00000000-0000-4000-8000-' + number.toString(16).padStart(12, '0');
      await store.confirm({ requestId, accountId: number <= 500 ? 8 : 7, profileName: 'removed-profile',
        profileInstanceId: ${JSON.stringify(historyInstanceId)}, direction: 'deposit', amountPlur: '5000000000000000',
        createdAt: '2026-09-08T00:00:00.000Z' }, number <= 500 ? previous : null); previous = requestId; own = requestId; }
    await store.close(); return own; })()`);
  await browser.call('Page.navigate', { url: `${h.origin}/#/transfers` });
  await visible(browser, 'More saved requests');
  assert.equal(await browser.evaluate("document.body?.innerText.includes('No requests are saved on this browser for this account')"), false);
  await click(browser, 'More saved requests');
  await visible(browser, requestId);
  assert.deepEqual(h.posts, []);
});

test('unavailable optional browser storage does not hide manager detail or leak cleanup errors', async t => {
  const h = await launchHistoryFixture(t, 1);
  const browser = await launchChrome(t, h.origin);
  await browser.call('Page.addScriptToEvaluateOnNewDocument', { source: "IDBFactory.prototype.open = function () { throw new Error('synthetic-private-storage-diagnostic'); };" });
  await browser.call('Page.navigate', { url: `${h.origin}/#/transfers` });
  await visible(browser, 'Saved status: settled');
  await visible(browser, 'Saved browser requests could not be read');
  await route(browser, `#/transfers/${h.records[0].id}`);
  await visible(browser, 'Transfer verified on chain');
  await visible(browser, 'Browser request information could not be read');
  assert.equal(await browser.evaluate("document.body?.innerText.includes('synthetic-private-storage-diagnostic')"), false);
  await route(browser, '#/transfers');
  await visible(browser, 'Saved browser requests could not be read');
  assert.deepEqual(browser.errors, []);
  assert.deepEqual(h.posts, []);
});

test('an exact request read respects a previously proven local operation link on first load', async t => {
  const h = await launchHistoryFixture(t, 1);
  const operation = h.journal.detail(h.records[0].id).operation;
  const browser = await launchChrome(t, h.origin);
  await browser.call('Page.navigate', { url: `${h.origin}/dev/t09-intent-tests.html` });
  await browser.evaluate(`(async () => { const { IndexedDbTransferIntentStore } = await import('/src/transfers/transferIntentStore.ts');
    const store = new IndexedDbTransferIntentStore(indexedDB); const operation = ${JSON.stringify(operation)};
    await store.confirm({ requestId: operation.requestId, accountId: 7, profileName: operation.profileName,
      profileInstanceId: operation.profileInstanceId, direction: operation.direction, amountPlur: operation.amountPlur, createdAt: operation.createdAt }, null);
    await store.recordExact(operation.requestId, operation); await store.close(); })()`);
  const changed = h.journal.detail(operation.id);
  changed.operation.nodeAddress = `0x${'aa'.repeat(20)}`;
  h.override(url => url.pathname.includes('/by-request/') ? { status: 200, body: changed } : null);
  await browser.call('Page.navigate', { url: `${h.origin}/#/transfers/request/${operation.requestId}` });
  await visible(browser, 'Returned details do not match this saved transfer');
  assert.equal(await browser.evaluate("document.body?.innerText.includes('Transfer verified on chain')"), false);
  assert.deepEqual(h.posts, []);
});

test('later attribution conflict keeps the recorded assertion visible without a settlement label', async t => {
  const h = await launchHistoryFixture(t, 1);
  const detail = h.journal.detail(h.records[0].id);
  detail.operation.state = 'asserted';
  detail.operation.failureReason = 'hash_conflict';
  detail.operation.assertion = { actor: 'user:19', amountPlur: detail.operation.amountPlur,
    confirmation: detail.assertionConfirmation, assertedAt: '2026-09-08T01:02:03.000Z' };
  detail.operation.receiptObservation = { kind: 'could_not_check', reason: 'attribution_conflict' };
  detail.responseEvidence.push({ transactionHash: `0x${'99'.repeat(32)}`, ownership: 'conflict', receivedAt: '2026-09-08T01:03:03.000Z' });
  h.override(url => url.pathname.endsWith(detail.operation.id) ? { status: 200, body: detail } : null);
  const browser = await app(t, h, `#/transfers/${detail.operation.id}`);
  await visible(browser, 'Transaction evidence needs review');
  await visible(browser, 'Asserted by');
  await visible(browser, 'user:19');
  await visible(browser, detail.operation.assertion.confirmation);
  assert.equal(await browser.evaluate("document.body?.innerText.includes('Transfer verified on chain')"), false);
  assert.deepEqual(h.posts, []);
  assert.deepEqual(browser.errors, []);
});
