/**
 * What the browser fixtures leave on the machine.
 *
 * Every fixture used to build its own 9 MB Vite cache inside a fresh evidence
 * directory in the temporary directory, and nothing ever removed either. A full
 * run of the transfer suites starts nine of them, so the machine collected
 * gigabytes of caches that no run ever read again.
 *
 * No browser here. These cases start Vite fixtures of their own and look at
 * what each one leaves behind.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { json, launchTransferFixture } from './support/transfer-fixture.mjs';
import { viteCacheFor } from './support/vite-cache.mjs';

const sharedCache = viteCacheFor('transfer');

/** A parent of this test's own, so a fixture started by another session cannot answer for it. */
async function ownedEvidenceParent(t) {
  const parent = await mkdtemp(join(tmpdir(), 't09-fixture-evidence-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return parent;
}

/**
 * A stand-in for the runner's own context, so a teardown hook can be run here
 * and what it reported can be read.
 *
 * Node stops at the first `after` hook that throws and never runs the rest, so
 * a hook that gives up halfway leaves its own children behind. Running the
 * hooks here is the only way to watch that from inside a passing test.
 */
function collectedTeardown() {
  const hooks = [];
  return {
    context: { after: (hook) => hooks.push(hook), diagnostic: () => undefined },
    async run() {
      for (const hook of hooks) await hook();
    },
  };
}

test('a fixture teardown that cannot write its log still closes the servers it opened', async t => {
  const evidenceParent = await ownedEvidenceParent(t);
  const teardown = collectedTeardown();
  const fixture = await launchTransferFixture(teardown.context, (_req, res) => json(res, 404, {}), { evidenceParent });
  assert.match(String(fixture.managerOrigin), /^http:\/\/127\.0\.0\.1:\d+$/, 'the fixture names the synthetic API it owns');
  await rm(fixture.evidence, { recursive: true, force: true });

  await assert.rejects(teardown.run(), { code: 'ENOENT' }, 'the hook still reports the step it could not finish');

  await assert.rejects(fetch(fixture.managerOrigin), 'the synthetic API the fixture owns was closed anyway');
  await assert.rejects(fetch(fixture.origin), 'and so was the Vite in front of it');
});

test('a run with nothing to report leaves no evidence directory behind', async t => {
  const evidenceParent = await ownedEvidenceParent(t);
  let origin = '';
  let evidence = '';
  await t.test('one owned fixture', async inner => {
    const fixture = await launchTransferFixture(inner, (_req, res) => json(res, 404, {}), { evidenceParent });
    origin = fixture.origin;
    evidence = fixture.evidence;
    assert.ok((await stat(evidence)).isDirectory(), 'the fixture has somewhere to put evidence while it runs');
  });
  assert.ok(origin.startsWith('http://127.0.0.1:'), 'the fixture served loopback only');
  await assert.rejects(stat(evidence), { code: 'ENOENT' }, 'a fixture with nothing to report removes its own evidence directory');
  assert.deepEqual(await readdir(evidenceParent), [], 'and leaves nothing behind in the directory it was handed');
});

test('every fixture builds into the one shared Vite cache and never into one of its own', async t => {
  const evidenceParent = await ownedEvidenceParent(t);
  const caches = [];
  for (const name of ['first fixture', 'second fixture']) {
    await t.test(name, async inner => {
      const fixture = await launchTransferFixture(inner, (_req, res) => json(res, 404, {}), { evidenceParent });
      caches.push(fixture.viteCache);
      assert.deepEqual(await readdir(fixture.evidence), [], 'the running fixture built nothing beside its own evidence');
    });
  }
  assert.equal(caches[0], sharedCache, 'the fixture named the one cache the transfer suites share');
  assert.equal(caches[1], caches[0], 'and the fixture after it built into that same cache');
  assert.ok((await stat(caches[0])).isDirectory(), 'which is a directory the run can actually reuse');
});

test('the Vite fixture binds the port it probed and never one from the environment', async t => {
  const planted = '54291';
  process.env.T09_VITE_PORT = planted;
  t.after(() => { delete process.env.T09_VITE_PORT; });
  const fixture = await launchTransferFixture(t, (_req, res) => json(res, 404, {}));
  assert.notEqual(new URL(fixture.origin).port, planted, 'the port came from the fixture probe and not from the environment');
});
