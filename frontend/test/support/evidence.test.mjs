/**
 * Where the browser suites are allowed to put a screenshot.
 *
 * Three of them wrote to /private/tmp/t1X-browser-evidence, a fixed path,
 * created recursively and without a guard. On a Linux runner as an ordinary
 * user /private does not exist and / belongs to root, so the first mkdir
 * raises EACCES and the suite fails for a reason that has nothing to do with
 * what it tests. A fixed path nobody cleans is also the classic place to
 * leave a symlink for someone else's run to follow. Every other suite here
 * makes a directory of its own under RUNNER_TEMP or the OS temp directory,
 * and this file is what keeps that true.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { evidenceDirectory } from './evidence.mjs';

const suiteDirectory = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * A path into someone else's tree, written into a suite. The roots a run
 * could put a file in, not every absolute path: the browser's own executable
 * is read from one and that is what CHROME_BIN is for.
 */
const WRITTEN_PATH_RE = /(['"`])(\/(?:private|tmp|var|Users|home)\/[^'"`]*)/g;

function suiteFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? suiteFiles(join(directory, entry.name))
      : entry.name.endsWith('.mjs')
        ? [join(directory, entry.name)]
        : [],
  );
}

describe('the evidence the browser suites leave behind', () => {
  it('goes in no path written into the suite itself', () => {
    const written = suiteFiles(suiteDirectory).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(WRITTEN_PATH_RE)].map(
        ([, , path]) => `${file.slice(suiteDirectory.length + 1)} writes to ${path}`,
      ),
    );
    assert.deepEqual(written, [], 'a run can only write in a directory it made itself');
  });
});

describe('the directory a suite is given', () => {
  it('is made under RUNNER_TEMP where the job has one', async () => {
    const runnerTemp = await mkdtemp(join(tmpdir(), 'runner-temp-'));
    try {
      process.env.RUNNER_TEMP = runnerTemp;
      const made = await evidenceDirectory('t11-browser-evidence-');
      assert.equal(dirname(made), runnerTemp);
    } finally {
      delete process.env.RUNNER_TEMP;
      await rm(runnerTemp, { recursive: true, force: true });
    }
  });

  it('is made under the OS temp directory where the job has none', async () => {
    delete process.env.RUNNER_TEMP;
    const made = await evidenceDirectory('t11-browser-evidence-');
    try {
      assert.equal(dirname(made), tmpdir());
      assert.match(made, /t11-browser-evidence-/);
    } finally {
      await rm(made, { recursive: true, force: true });
    }
  });

  it('is a new one every time, so two runs cannot land in one place', async () => {
    delete process.env.RUNNER_TEMP;
    const [one, two] = await Promise.all([evidenceDirectory('t12-'), evidenceDirectory('t12-')]);
    try {
      assert.notEqual(one, two);
    } finally {
      await Promise.all([rm(one, { recursive: true, force: true }), rm(two, { recursive: true, force: true })]);
    }
  });
});
