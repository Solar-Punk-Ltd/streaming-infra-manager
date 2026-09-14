/**
 * What a browser that will not start is allowed to cost.
 *
 * On the verification box every Chrome suite reported the same line, sixteen
 * files in a row: "Timed out waiting for Chrome debugging port". Chrome had
 * said why on its own standard error, immediately and in one line, and the
 * launcher spawned it with `stdio: 'ignore'`, so the only thing that reached
 * the run was the absence of a port file fifteen seconds later. Two whole deep
 * runs went on learning nothing from that, which is 53 identical errors and no
 * reason among them.
 *
 * A browser that dies is a browser that has already explained itself. These
 * cases hold the launcher to reporting the explanation, and to noticing the
 * death rather than waiting out a budget for a port that no live process is
 * going to write.
 *
 * A Node-only file: no browser, no Vite. `CHROME_BIN` points at a script that
 * behaves the way a refusing Chrome behaves.
 */
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { launchChrome } from './chrome.mjs';

/** Chrome's own words when it is asked to run as root without a sandbox. */
const REFUSAL = 'Running as root without --no-sandbox is not supported. See https://crbug.com/638180.';

/** A stand-in that refuses on standard error and exits, which is what a refusing Chrome does. */
async function browserThatRefuses(code = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'chrome-launch-'));
  const script = join(directory, 'chrome');
  await writeFile(script, `#!/bin/sh\necho '${REFUSAL}' >&2\nexit ${code}\n`);
  await chmod(script, 0o755);
  return script;
}

test('says what the browser said when it refuses to start', async (t) => {
  process.env.CHROME_BIN = await browserThatRefuses();

  const failure = await launchChrome(t, 'http://127.0.0.1:1').then(() => null, (error) => error);

  assert.ok(failure, 'a browser that exited must not look like a browser that started');
  assert.match(failure.message, /crbug\.com\/638180/, `the browser's own reason is missing: ${failure.message}`);
});

test('gives up when the browser is gone rather than waiting out the budget', async (t) => {
  process.env.CHROME_BIN = await browserThatRefuses();
  const startedAt = Date.now();

  await launchChrome(t, 'http://127.0.0.1:1').then(() => null, () => null);

  // The port wait alone is fifteen seconds. A process that has already exited
  // is never going to write the file it is waiting for.
  assert.ok(Date.now() - startedAt < 10_000, `waited ${Date.now() - startedAt}ms for a process that had exited`);
});

test('reports the exit status, because a refusal and a crash are different faults', async (t) => {
  process.env.CHROME_BIN = await browserThatRefuses(127);

  const failure = await launchChrome(t, 'http://127.0.0.1:1').then(() => null, (error) => error);

  assert.match(failure.message, /127/, `the exit status is missing: ${failure.message}`);
});
