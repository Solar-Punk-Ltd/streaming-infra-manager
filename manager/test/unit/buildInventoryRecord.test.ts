/**
 * The record of what a build was read to be, kept beside the build directory.
 *
 * A build is hashed once, when something first copies it, and every later copy
 * proves the build against this record by a stat walk. So the record has to be
 * refused whenever it might not describe the build under it, and a record that
 * cannot be read or written has to cost a deploy nothing but the reading it
 * saves.
 *
 * Unit test, no database and no Docker, but the builds are real files.
 */
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, it } from 'node:test';

import { Logger } from '../../src/domain/Logger.js';
import { buildInventory, buildInventoryRecordPath } from '../../src/domain/versions/buildInventoryRecord.js';
import { ownedTreeDigest, type OwnedTreeEntry } from '../../src/domain/versions/ownedTreeInventory.js';

const commit = 'a'.repeat(40);
let root: string;
let build: string;
let recordPath: string;
beforeEach(async () => {
  root = await fsPromises.mkdtemp(join(tmpdir(), 'build-inventory-record-'));
  build = join(root, 'builds', commit);
  await fsPromises.mkdir(join(build, 'deploy'), { recursive: true });
  await fsPromises.writeFile(join(build, 'deploy', 'deploy.sh'), '#!/bin/sh\nexit 0\n');
  await fsPromises.writeFile(join(build, '.env.sample'), 'ENGINE=synthetic\n');
  recordPath = buildInventoryRecordPath(build);
});
afterEach(async () => { await fsPromises.rm(root, { recursive: true, force: true }); });

/** Everything `open` is asked for under the builds root, answered by `answer` and otherwise passed through. */
function whenOpening(t: { mock: { method: typeof import('node:test').mock.method }; after: (fn: () => void) => void },
  path: string, answer: () => never): void {
  const real = fsPromises.open;
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof fsPromises.open>) => {
    if (String(args[0]) === path) answer();
    return real(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { syncBuiltinESMExports(); });
}

it('prepares the deploy anyway when its record cannot be read, and says which error stopped it', async t => {
  const warnings: string[] = [];
  t.mock.method(Logger.prototype, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')); });
  const first = await buildInventory(build);
  whenOpening(t, recordPath, () => { throw Object.assign(new Error('input output error'), { code: 'EIO' }); });

  const again = await buildInventory(build);

  assert.equal(again.hashed, true, 'a record that cannot be read was believed');
  assert.equal(again.record.digest, first.record.digest);
  assert.ok(warnings.some(line => line.includes('EIO')), warnings.join('\n'));
});

interface RecordOnDisk { rootMode: number; entries: OwnedTreeEntry[]; digest: string; durableStamps: Record<string, string> }

/** Rewrites the record the way somebody who can write beside the builds would, keeping it self consistent. */
async function forge(change: (record: RecordOnDisk) => void): Promise<void> {
  const record = JSON.parse(await fsPromises.readFile(recordPath, 'utf8')) as RecordOnDisk;
  change(record);
  record.digest = ownedTreeDigest(record);
  await fsPromises.writeFile(recordPath, JSON.stringify(record));
}

it('refuses a record that keeps a stamp for a path it has stopped listing', async () => {
  await buildInventory(build);
  await forge(record => { record.entries = record.entries.filter(entry => entry.path !== 'deploy/deploy.sh'); });

  const again = await buildInventory(build);

  assert.equal(again.hashed, true, 'a record naming fewer paths than it stamps was believed, so a copy made from it is missing them');
  assert.ok(again.record.entries.some(entry => entry.path === 'deploy/deploy.sh'));
});

it('refuses a record that re-declares one of the build files as a symbolic link', async () => {
  await buildInventory(build);
  await forge(record => {
    record.entries = record.entries.map(entry => entry.path === 'deploy/deploy.sh'
      ? { path: entry.path, mode: 0o777, type: 'symlink', target: '../.env.sample' }
      : entry);
  });

  const again = await buildInventory(build);

  assert.equal(again.hashed, true, 'a record that turned a build file into a link was believed, so the copy would be built that way');
  assert.ok(again.record.entries.some(entry => entry.path === 'deploy/deploy.sh' && entry.type === 'file'));
});

it('refuses a record that re-declares the mode of a file it stamped', async () => {
  await buildInventory(build);
  await forge(record => {
    record.entries = record.entries.map(entry => entry.path === 'deploy/deploy.sh' ? { ...entry, mode: 0o777 } : entry);
  });

  const again = await buildInventory(build);

  assert.equal(again.hashed, true, 'a record that changed a file mode was believed, so the copy would be made with it');
});
