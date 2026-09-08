import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchChrome } from './support/chrome.mjs';
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
