/**
 * What the browser fixtures leave on the machine.
 *
 * Every fixture used to build its own 9 MB Vite cache inside a fresh evidence
 * directory in the temporary directory, and nothing ever removed either. A full
 * run of the transfer suites starts nine of them, so the machine collected
 * gigabytes of caches that no run ever read again.
 *
 * No browser here. This starts one Vite fixture and looks at the machine.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { json, launchTransferFixture } from './support/transfer-fixture.mjs';

const sharedCache = fileURLToPath(new URL('../node_modules/.vite-t09', import.meta.url));

/** A parent of this test's own, so a fixture started by another session cannot answer for it. */
async function ownedEvidenceParent(t) {
  const parent = await mkdtemp(join(tmpdir(), 't09-fixture-evidence-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return parent;
}

test('a run with nothing to report leaves no evidence directory and shares one Vite cache', async t => {
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
  assert.ok((await stat(sharedCache)).isDirectory(), 'the Vite cache is shared by every fixture and stays where it is');
});

test('the Vite fixture binds the port it probed and never one from the environment', async t => {
  const planted = '54291';
  process.env.T09_VITE_PORT = planted;
  t.after(() => { delete process.env.T09_VITE_PORT; });
  const fixture = await launchTransferFixture(t, (_req, res) => json(res, 404, {}));
  assert.notEqual(new URL(fixture.origin).port, planted, 'the port came from the fixture probe and not from the environment');
});
