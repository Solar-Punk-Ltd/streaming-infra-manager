/**
 * What the Chrome teardown has to end, and what it must never fail a suite for.
 *
 * On the browser job's first run every Chrome suite ended `not ok` with
 * `ENOTEMPTY: directory not empty, rmdir '/tmp/t15-chrome-XXXX/Default'`, and
 * the job was cancelled at its thirty minute limit with a chrome and two
 * chrome_crashpad_handler processes still alive. Chrome's helpers are not the
 * process `spawn` returned. On Linux they outlive it by a moment, and while
 * they live they keep writing into the profile the removal is walking.
 *
 * The synthetic tree below is that shape without a browser: a main process
 * that ends on SIGTERM the way Chrome does, and a helper it started that
 * ignores SIGTERM and keeps filling the profile.
 *
 * A Node-only file: no browser, no Vite.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { endChromeSession, removeProfile, waitFor } from './chrome.mjs';

/** Ignores SIGTERM and keeps the profile busy, which is what breaks a plain recursive removal. */
const HELPER = `
  const fs = require('node:fs');
  const profile = process.argv[1];
  process.on('SIGTERM', () => {});
  fs.writeFileSync(profile + '/helper.pid', String(process.pid));
  let written = 0;
  setInterval(() => {
    for (let index = 0; index < 5; index++) fs.writeFileSync(profile + '/Default/busy-' + (written++), 'x');
  }, 1);
`;

/** Ends on SIGTERM, like Chrome, and leaves the helper above behind when it goes. */
const MAIN = `
  const { spawn } = require('node:child_process');
  spawn(process.execPath, ['-e', ${JSON.stringify(HELPER)}, process.argv[1]], { stdio: 'ignore' });
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
`;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/** Whatever the case under test left, swept by process group, so nothing of this file outlives it. */
function sweepAfter(t, child, profile) {
  t.after(async () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is already gone */ }
    await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
}

/** A profile and a two-process tree writing into it, started the way launchChrome starts Chrome. */
async function syntheticChrome(t) {
  const profile = await mkdtemp(join(tmpdir(), 't15-chrome-synthetic-'));
  await mkdir(join(profile, 'Default'));
  const child = spawn(process.execPath, ['-e', MAIN, profile], { stdio: 'ignore', detached: true });
  sweepAfter(t, child, profile);
  const helperPid = await waitFor(async () => {
    try { return Number(await readFile(join(profile, 'helper.pid'), 'utf8')); }
    catch { return null; }
  }, Boolean, 'the synthetic helper to report its pid');
  return { profile, child, helperPid };
}

/** Only the diagnostics are read here, and a stand-in makes them readable. */
function reporting() {
  const said = [];
  return { said, reporter: { diagnostic: (line) => said.push(line) } };
}

test('the teardown ends the helper the browser started, and not only the browser', async t => {
  const { profile, child, helperPid } = await syntheticChrome(t);
  const { said, reporter } = reporting();

  await endChromeSession(reporter, child, profile);

  await waitFor(() => !alive(helperPid), Boolean, 'the helper that outlived the main process to be gone', 5000);
  await assert.rejects(stat(profile), { code: 'ENOENT' }, 'and the profile it was writing into went with it');
  assert.deepEqual(said, [], 'a teardown that succeeded says nothing');
});

test('a profile that stays busy is given up on inside the budget rather than waited on forever', async t => {
  const { profile } = await syntheticChrome(t);
  const started = Date.now();

  const failure = await removeProfile(profile, { budgetMs: 400, stepMs: 50 });

  assert.ok(failure instanceof Error, 'the removal reported what stopped it rather than throwing');
  assert.ok(failure.message.includes(profile), `the removal named the profile it could not remove: ${failure.message}`);
  assert.ok(Date.now() - started >= 400, 'it retried for the whole budget');
  assert.ok(Date.now() - started < 10_000, 'and stopped at the end of it');
});

test('a profile that cannot be removed is a diagnostic and never a failed suite', async t => {
  const { profile, child } = await syntheticChrome(t);
  const { said, reporter } = reporting();
  const refuses = () => {
    const error = new Error(`EBUSY: resource busy or locked, rmdir '${profile}'`);
    error.code = 'EBUSY';
    return Promise.reject(error);
  };

  await endChromeSession(reporter, child, profile, { remove: refuses, budgetMs: 100, stepMs: 20 });

  assert.equal(said.length, 1, 'the leftover was reported once');
  assert.ok(said[0].includes(profile), `the leftover was named so someone can sweep it: ${said[0]}`);
  assert.ok((await stat(profile)).isDirectory(), 'and the profile really is still there to be named');
});
