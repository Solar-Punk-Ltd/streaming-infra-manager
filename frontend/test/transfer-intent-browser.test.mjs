import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchChrome, waitFor } from './support/chrome.mjs';

const origin = 'http://127.0.0.1:54291';
test('native IndexedDB keeps one immutable intent across concurrent browser connections', async t => {
  const browser = await launchChrome(t, origin);
  await browser.call('Page.navigate', { url: `${origin}/dev/t09-intent-tests.html` });
  await waitFor(() => browser.evaluate("typeof document.querySelector('#run')?.onclick === 'function'"));
  await browser.evaluate("document.querySelector('#run').click()");
  const result = await waitFor(() => browser.evaluate("document.querySelector('#result').textContent"),
    value => value !== 'Ready' && value !== 'Running', 'native intent test result');
  assert.ok(!result.startsWith('FAILED:'), result);
  assert.equal(JSON.parse(result).passed, 6);
  assert.deepEqual(browser.errors, []);
  assert.deepEqual(browser.blockedRequests, []);
  t.diagnostic(`Verified ${browser.version} with an isolated temporary profile`);
});
