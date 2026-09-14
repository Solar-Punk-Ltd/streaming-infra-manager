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

/**
 * What a wait that ran out is allowed to leave behind.
 *
 * On the verification box seven browser files each ended on a wait that printed
 * its description and nothing else, so the log said which condition was never
 * met and never what the page had actually said instead. All seven pass on a
 * laptop, which is the case where the difference between "the page never
 * loaded" and "the page loaded and said something else" decides whether the
 * fault is the test's budget or the product's behaviour. The description alone
 * cannot tell those apart.
 */
test('a wait that runs out says what it last saw, not only what it wanted', async () => {
  const failure = await waitFor(() => 'the manager did not answer', () => false, 'the deployment page', 60)
    .then(() => null, (error) => error);

  assert.match(failure.message, /the deployment page/);
  assert.match(failure.message, /the manager did not answer/, `the last reading is missing: ${failure.message}`);
});

test('a wait whose budget was already spent says it never looked', async () => {
  const failure = await waitFor(() => 'anything', () => false, 'a thing', 0)
    .then(() => null, (error) => error);

  assert.match(failure.message, /never read anything/, failure.message);
});

test('a reading of undefined is reported as that, since it is a reading', async () => {
  const failure = await waitFor(() => undefined, () => false, 'a thing', 60)
    .then(() => null, (error) => error);

  assert.match(failure.message, /undefined/, failure.message);
});

test('a long last reading is cut rather than pasted whole into a log', async () => {
  const failure = await waitFor(() => 'x'.repeat(5000), () => false, 'a thing', 60)
    .then(() => null, (error) => error);

  assert.ok(failure.message.length < 500, `the whole page went into the message: ${failure.message.length} characters`);
});
