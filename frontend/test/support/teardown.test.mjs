/**
 * What a teardown hook has to finish even when part of it fails.
 *
 * Node's test runner stops at the first `after` hook that throws, so a hook
 * that gives up halfway leaves its own children running and no later hook ever
 * runs either. A live child keeps the test file's process alive, and that is
 * how the browser job's first run went from three failed suites to a
 * cancellation at its thirty minute limit.
 *
 * A Node-only file: no browser, no Vite.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { runEveryStep } from './teardown.mjs';

test('every step runs, in order, even when the first one throws', async () => {
  const ran = [];

  await assert.rejects(runEveryStep([
    () => { ran.push('stop the Vite child'); throw new Error('the child was already gone'); },
    () => { ran.push('write the evidence log'); },
    async () => { ran.push('close the synthetic API'); },
  ]), /the child was already gone/);

  assert.deepEqual(ran, ['stop the Vite child', 'write the evidence log', 'close the synthetic API']);
});

test('a step that rejects is caught the same way as one that throws', async () => {
  const ran = [];

  await assert.rejects(runEveryStep([
    () => Promise.reject(new Error('the log had nowhere to go')),
    () => { ran.push('close the synthetic API'); },
  ]), /the log had nowhere to go/);

  assert.deepEqual(ran, ['close the synthetic API']);
});

test('the first failure is the one reported, since it is the one that explains the rest', async () => {
  await assert.rejects(runEveryStep([
    () => { throw new Error('the Vite child would not stop'); },
    () => { throw new Error('and so its log was never written'); },
  ]), /the Vite child would not stop/);
});

test('a teardown whose steps all passed reports nothing', async () => {
  const ran = [];

  await runEveryStep([() => ran.push('one'), async () => ran.push('two')]);

  assert.deepEqual(ran, ['one', 'two']);
});
