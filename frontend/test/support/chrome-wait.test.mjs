/**
 * What a browser wait has to say before it is allowed to start.
 *
 * A timeout in these suites prints its description and nothing else, so a wait
 * that has none reads "Timed out waiting for condition" in an Actions log and
 * cannot be diagnosed at all. 63 of the 179 waits were like that, in the
 * fourteen suites that drive a real Chrome, which is exactly where a flake is
 * hardest to reproduce.
 *
 * A Node-only file: no browser, no Vite.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { waitFor } from './chrome.mjs';

const SAYS_WHAT = /says what it is waiting for/;

test('a wait with no description refuses rather than starting', async () => {
  await assert.rejects(() => waitFor(() => true), SAYS_WHAT);
  await assert.rejects(() => waitFor(() => true, Boolean), SAYS_WHAT);
});

for (const empty of ['', '   ', '\n']) {
  test(`a description of ${JSON.stringify(empty)} is no description`, async () => {
    await assert.rejects(() => waitFor(() => true, Boolean, empty), SAYS_WHAT);
  });
}

test('a timeout names the thing that never happened', async () => {
  await assert.rejects(
    () => waitFor(() => false, Boolean, 'the deposit row to appear', 30),
    /Timed out waiting for the deposit row to appear/,
  );
});

test('a described wait answers with the value it accepted', async () => {
  const value = await waitFor(() => 'ready', (text) => text === 'ready', 'the page to say ready');
  assert.equal(value, 'ready');
});
