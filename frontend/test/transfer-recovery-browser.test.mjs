import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchHistoryFixture, historyReceipt } from './support/history-fixture.mjs';
import { launchChrome, waitFor } from './support/chrome.mjs';

const hash = `0x${'55'.repeat(32)}`;
const otherHash = `0x${'66'.repeat(32)}`;
const completeNoMatch = operation => ({ kind: 'no_match', candidateHashes: [], scan: {
  headBlockNumber: '510', headBlockHash: `0x${'aa'.repeat(32)}`, nextBlockNumber: operation.startBlockNumber,
  nextBlockHash: operation.startBlockHash, complete: true, candidateHashes: [],
} });
async function visible(browser, text) {
  await waitFor(() => browser.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`), Boolean, text);
}
async function click(browser, text) {
  await waitFor(() => browser.evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)}); return !!button && !button.disabled; })()`), Boolean, text);
  await browser.evaluate(`([...document.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)})).click()`);
}
async function input(browser, label, value) {
  await browser.evaluate(`(() => { const label = [...document.querySelectorAll('label')].find(label => label.textContent.includes(${JSON.stringify(label)}));
    const field = document.getElementById(label.htmlFor); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}
async function exists(browser, text) {
  return browser.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`);
}
async function app(t, fixture) {
  const browser = await launchChrome(t, fixture.origin);
  await browser.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await browser.call('Page.navigate', { url: `${fixture.origin}/#/transfers/${fixture.records[0].id}` });
  await visible(browser, 'Recovery actions');
  return browser;
}
async function screenshot(browser, fixture, name, width) {
  await browser.call('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 1000, deviceScaleFactor: 1, mobile: width === 390 });
  await browser.evaluate("[...document.querySelectorAll('h6')].find(element => element.textContent === 'Recovery actions')?.scrollIntoView()");
  await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  const path = join(fixture.evidence, `${name}-${width}.png`);
  const { data } = await browser.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(path, Buffer.from(data, 'base64'));
  return path;
}
async function assertionReview(browser, fixture) {
  await click(browser, 'Record operator assertion');
  await visible(browser, 'Type the exact statement');
  await input(browser, 'Type the exact statement', fixture.journal.detail(fixture.records[0].id).assertionConfirmation);
  await click(browser, 'Review assertion');
  await visible(browser, 'Confirm the operator assertion');
}
function noMoneyPosts(fixture) { assert.ok(fixture.posts.every(path => /\/chequebook\/operations\/.+\/(check|resolve|assert)$/.test(path))); }

test('partial, unavailable and ambiguous recovery require explicit checks and never enable an assertion', async t => {
  let step = 0;
  const fixture = await launchHistoryFixture(t, 1, { seedState: 'unknown', recoveryFor: operation => {
    step++;
    if (step === 1) return { kind: 'searching', candidateHashes: [], scan: { ...completeNoMatch(operation).scan, complete: false, nextBlockNumber: '505', nextBlockHash: `0x${'bb'.repeat(32)}` } };
    if (step === 2) return { kind: 'could_not_check', reason: 'rpc_unavailable', candidateHashes: [] };
    return { kind: 'ambiguous', candidateHashes: [hash, otherHash] };
  } });
  const browser = await app(t, fixture);
  assert.equal(step, 0);
  assert.equal(await exists(browser, 'Record operator assertion'), false);
  await click(browser, 'Search transaction history');
  await visible(browser, 'Continue transaction search');
  assert.equal(step, 1);
  assert.equal(await exists(browser, 'Record operator assertion'), false);
  await click(browser, 'Continue transaction search');
  await visible(browser, 'The chain service could not be reached');
  assert.equal(await exists(browser, 'Record operator assertion'), false);
  await click(browser, 'Continue transaction search');
  await visible(browser, 'Transaction evidence needs review');
  await visible(browser, otherHash);
  assert.equal(await exists(browser, 'Record operator assertion'), false);
  assert.equal(step, 3);
  await click(browser, 'Refresh saved evidence');
  await visible(browser, 'Transaction evidence needs review');
  assert.equal(step, 3);
  noMoneyPosts(fixture);
  assert.deepEqual(browser.errors, []);
});

test('manual hash recovery works after profile deletion and a pending receipt needs another explicit check', async t => {
  let receiptCalls = 0;
  const hashes = [];
  const fixture = await launchHistoryFixture(t, 1, { seedState: 'unknown', recoveryFor: (_operation, supplied) => {
    hashes.push(supplied);
    return supplied === hash ? { kind: 'candidate', candidateHashes: [hash] } : { kind: 'could_not_check', reason: 'identity_mismatch', candidateHashes: [] };
  }, receiptFor: () => ++receiptCalls === 1 ? { kind: 'pending', reason: 'awaiting_receipt' } : historyReceipt });
  const browser = await app(t, fixture);
  await input(browser, 'Transaction hash', otherHash);
  await click(browser, 'Check this transaction hash');
  await visible(browser, 'The transaction did not match');
  await input(browser, 'Transaction hash', hash);
  await click(browser, 'Check this transaction hash');
  await visible(browser, 'Waiting for transaction confirmation');
  assert.equal(receiptCalls, 1);
  await click(browser, 'Refresh saved evidence');
  await visible(browser, 'Waiting for transaction confirmation');
  assert.equal(receiptCalls, 1);
  await click(browser, 'Check transaction receipt');
  await visible(browser, 'Transfer verified on chain');
  assert.equal(receiptCalls, 2);
  assert.deepEqual(hashes, [otherHash, hash]);
  noMoneyPosts(fixture);
});

test('D10 requires the exact sentence and a second confirmation and remains an operator assertion', async t => {
  const fixture = await launchHistoryFixture(t, 1, { seedState: 'unknown', recoveryFor: completeNoMatch });
  const browser = await app(t, fixture);
  await click(browser, 'Search transaction history');
  await click(browser, 'Record operator assertion');
  await input(browser, 'Type the exact statement', 'I think it is safe');
  assert.equal(await browser.evaluate("[...document.querySelectorAll('button')].find(button => button.textContent === 'Review assertion').disabled"), true);
  await input(browser, 'Type the exact statement', fixture.journal.detail(fixture.records[0].id).assertionConfirmation);
  await click(browser, 'Review assertion');
  await visible(browser, 'Confirm the operator assertion');
  assert.equal(fixture.posts.filter(path => path.endsWith('/assert')).length, 0);
  t.diagnostic(await screenshot(browser, fixture, 'transfer-assertion-confirmation', 1280));
  t.diagnostic(await screenshot(browser, fixture, 'transfer-assertion-confirmation', 390));
  await click(browser, 'Record assertion');
  await visible(browser, 'Operator assertion recorded');
  assert.equal(await exists(browser, 'Transfer verified on chain'), false);
  assert.equal(fixture.journal.detail(fixture.records[0].id).operation.assertion.actor, 'user:7');
  assert.equal(fixture.posts.filter(path => path.endsWith('/assert')).length, 1);
  noMoneyPosts(fixture);
  assert.deepEqual(browser.errors, []);
});

test('new evidence invalidates the reviewed assertion before POST and clears its confirmation', async t => {
  const fixture = await launchHistoryFixture(t, 1, { seedState: 'unknown', recoveryFor: completeNoMatch });
  const browser = await app(t, fixture);
  await click(browser, 'Search transaction history');
  await assertionReview(browser, fixture);
  fixture.journal.observeResponse(fixture.records[0].id, hash);
  await click(browser, 'Record assertion');
  await visible(browser, 'The saved transfer changed');
  await visible(browser, 'Waiting for transaction confirmation');
  assert.equal(await exists(browser, 'Confirm the operator assertion'), false);
  assert.equal(fixture.posts.filter(path => path.endsWith('/assert')).length, 0);
  noMoneyPosts(fixture);
});

test('lost assertion response stays explicit while a GET refresh discovers its record without repeating it', async t => {
  const fixture = await launchHistoryFixture(t, 1, { seedState: 'unknown', recoveryFor: completeNoMatch });
  const browser = await app(t, fixture);
  await click(browser, 'Search transaction history');
  await assertionReview(browser, fixture);
  fixture.loseNextActionResponse();
  await click(browser, 'Record assertion');
  await visible(browser, 'The action response was not received');
  await visible(browser, 'Operator assertion recorded');
  await click(browser, 'Refresh saved evidence');
  await visible(browser, 'Operator assertion recorded');
  assert.equal(fixture.posts.filter(path => path.endsWith('/assert')).length, 1);
  assert.equal(await exists(browser, 'Transfer verified on chain'), false);
  noMoneyPosts(fixture);
});

test('a held pre-action detail cannot dispatch after navigation and a cookie account change is refused', async t => {
  let inspections = 0;
  const fixture = await launchHistoryFixture(t, 1, { seedState: 'unknown', recoveryFor: operation => { inspections++; return completeNoMatch(operation); } });
  const browser = await app(t, fixture);
  const held = fixture.holdOnce(fixture.records[0].id);
  await click(browser, 'Search transaction history');
  await held.entered;
  await browser.evaluate("location.hash = '#/transfers'");
  await visible(browser, 'Transfer history');
  held.release();
  await browser.evaluate('new Promise(resolve => setTimeout(resolve, 100))');
  assert.deepEqual(fixture.posts, []);
  await browser.evaluate(`location.hash = '#/transfers/${fixture.records[0].id}'`);
  await visible(browser, 'Recovery actions');
  fixture.override(url => {
    if (url.pathname.endsWith(fixture.records[0].id)) { fixture.setAccount(8); return { status: 200, body: fixture.journal.detail(fixture.records[0].id) }; }
    return null;
  });
  await click(browser, 'Search transaction history');
  await visible(browser, 'The signed-in account changed');
  assert.equal(inspections, 0);
  assert.equal(fixture.posts.length, 1);
  noMoneyPosts(fixture);
});

test('hung detail and action requests release the UI without an automatic retry', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const fixture = await launchHistoryFixture(t, 1, { seedState: 'unknown', recoveryFor: () => pending });
  t.after(() => release({ kind: 'could_not_check', reason: 'rpc_unavailable', candidateHashes: [] }));
  const browser = await app(t, fixture);
  await browser.evaluate('globalThis.realSetTimeout = setTimeout; globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, [15000, 60000].includes(delay) ? 100 : delay, ...args)');
  const held = fixture.holdOnce(fixture.records[0].id);
  await click(browser, 'Search transaction history');
  await held.entered;
  await visible(browser, 'Fresh evidence could not be read');
  assert.deepEqual(fixture.posts, []);
  held.release();
  await visible(browser, 'Search transaction history');
  await click(browser, 'Search transaction history');
  await visible(browser, 'The action response was not received');
  await visible(browser, 'Search transaction history');
  assert.equal(fixture.posts.length, 1);
  t.diagnostic(await screenshot(browser, fixture, 'transfer-recovery-unknown', 1280));
  t.diagnostic(await screenshot(browser, fixture, 'transfer-recovery-unknown', 390));
  noMoneyPosts(fixture);
});
