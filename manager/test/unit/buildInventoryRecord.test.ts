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
import { existsSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, it, type TestContext } from 'node:test';

import { Logger } from '../../src/domain/Logger.js';
import {
  buildInventory,
  buildInventoryRecordPath,
  forgetRecordsOfGoneBuilds,
  parseBuildInventoryRecord,
} from '../../src/domain/versions/buildInventoryRecord.js';
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

type MockedCall = 'open' | 'lstat' | 'rename';

/** Replaces one filesystem call for the length of one test, and puts the named import back with it. */
function insteadOf<K extends MockedCall>(t: TestContext, name: K, replacement: typeof fsPromises[K]): void {
  const mocked = t.mock.method(fsPromises, name, replacement);
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
}

/** The same call, refusing one path with `code` and passing every other through. */
function refusing<K extends MockedCall>(name: K, path: string, code: string): typeof fsPromises[K] {
  const real = fsPromises[name];
  return (async (...args: unknown[]) => {
    if (String(args[0]) === path) throw Object.assign(new Error(`${name} refused ${code}`), { code });
    return (real as (...given: unknown[]) => unknown)(...args);
  }) as typeof fsPromises[K];
}

it('prepares the deploy anyway when its record cannot be read, and says which error stopped it', async t => {
  const warnings: string[] = [];
  t.mock.method(Logger.prototype, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')); });
  const first = await buildInventory(build);
  insteadOf(t, 'open', refusing('open', recordPath, 'EIO'));

  const again = await buildInventory(build);

  assert.equal(again.hashed, true, 'a record that cannot be read was believed');
  assert.equal(again.record.digest, first.record.digest);
  assert.ok(warnings.some(line => line.includes('EIO')), warnings.join('\n'));
});

interface RecordOnDisk {
  format: number;
  buildId: string;
  rootMode: number;
  entries: OwnedTreeEntry[];
  digest: string;
  durableStamps: Record<string, string>;
}

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

it('writes no record for a build holding a path its stamps cannot keep, and says why once', async t => {
  // `stamps['__proto__'] = ...` sets a prototype instead of a key, so such a record is one reading it back refuses.
  const warnings: string[] = [];
  t.mock.method(Logger.prototype, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')); });
  await fsPromises.writeFile(join(build, '__proto__'), 'SYNTHETIC=proto\n');

  const taken = await buildInventory(build);

  assert.equal(taken.hashed, true);
  assert.equal(existsSync(recordPath), false, 'a record was written that reading it back would refuse, so this build is re-hashed for ever');
  assert.equal(warnings.filter(line => line.includes(build)).length, 1, warnings.join('\n'));
});

it('keeps a record whose build the filesystem would not answer about', async t => {
  await buildInventory(build);
  insteadOf(t, 'lstat', refusing('lstat', build, 'EACCES'));

  await forgetRecordsOfGoneBuilds(dirname(build));

  assert.ok(existsSync(recordPath), 'a build the filesystem would not answer about was taken for one that is gone');
});

it('cleans up after a record it could not put in place, and lets the deploy go on', async t => {
  const warnings: string[] = [];
  t.mock.method(Logger.prototype, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')); });
  insteadOf(t, 'rename', (async () => { throw Object.assign(new Error('read only file system'), { code: 'EROFS' }); }) as typeof fsPromises.rename);

  const taken = await buildInventory(build);

  assert.equal(taken.hashed, true);
  assert.ok(warnings.some(line => line.includes('was not recorded')), warnings.join('\n'));
  assert.deepEqual((await fsPromises.readdir(dirname(build))).filter(name => name !== basename(build)), [],
    'a half written record was left beside the builds');
});

it('reads back the record it wrote, and leaves nothing else beside the build', async () => {
  const first = await buildInventory(build);

  const second = await buildInventory(build);

  assert.equal(first.hashed, true);
  assert.equal(second.hashed, false, 'the record it had just written was not read back');
  assert.deepEqual(second.record, first.record);
  assert.deepEqual((await fsPromises.readdir(dirname(build))).sort(), [commit, `${commit}${'.inventory.json'}`]);
});

it('accepts a hard link made and removed while hashing an immutable build file', async t => {
  const file = join(build, 'deploy', 'deploy.sh');
  const transient = join(root, 'transient-build-link');
  const realOpen = fsPromises.open;
  let linked = false;
  insteadOf(t, 'open', (async (...args: unknown[]) => {
    const handle = await (realOpen as (...input: unknown[]) => ReturnType<typeof fsPromises.open>)(...args);
    if (!linked && String(args[0]) === file) {
      linked = true;
      await fsPromises.link(file, transient);
      await fsPromises.unlink(transient);
    }
    return handle;
  }) as typeof fsPromises.open);

  const taken = await buildInventory(build);

  assert.equal(linked, true, 'the build file was never linked during its read, so this test proves nothing');
  assert.equal(taken.hashed, true);
  assert.ok(taken.record.entries.some(entry => entry.path === 'deploy/deploy.sh' && entry.type === 'file'));
});

it('forgets the record of a build that is no longer there, and keeps the record of one that is', async () => {
  await buildInventory(build);
  const orphan = buildInventoryRecordPath(join(dirname(build), 'b'.repeat(40)));
  await fsPromises.writeFile(orphan, '{}');

  await forgetRecordsOfGoneBuilds(dirname(build));

  assert.equal(existsSync(orphan), false, 'the record of a pruned build stays for the next build at that id to inherit');
  assert.ok(existsSync(recordPath), 'the record of a build that is still there was taken');
});

it('refuses bytes that are not a sound record of this build', async () => {
  await buildInventory(build);
  const bytes = await fsPromises.readFile(recordPath);
  const sound = JSON.parse(bytes.toString('utf8')) as RecordOnDisk;
  const spoiled = (change: Partial<RecordOnDisk>) => Buffer.from(JSON.stringify({ ...sound, ...change }));

  assert.ok(parseBuildInventoryRecord(bytes, commit), 'this build own record does not parse, so the rows below prove nothing');
  assert.equal(parseBuildInventoryRecord(Buffer.from('not json at all'), commit), null, 'bytes that are not JSON');
  assert.equal(parseBuildInventoryRecord(bytes, 'b'.repeat(40)), null, 'a record of another build');
  assert.equal(parseBuildInventoryRecord(spoiled({ format: 2 }), commit), null, 'a format nothing here wrote');
  assert.equal(parseBuildInventoryRecord(spoiled({ digest: 'e'.repeat(64) }), commit), null, 'a digest of other entries');
  const unstamped = { ...sound.durableStamps };
  delete unstamped['.env.sample'];
  assert.equal(parseBuildInventoryRecord(spoiled({ durableStamps: unstamped }), commit), null, 'an entry with no stamp');
  const proto = sound.entries.map(entry => entry.path === '.env.sample' ? { ...entry, path: '__proto__' } : entry);
  assert.equal(parseBuildInventoryRecord(spoiled({ entries: proto }), commit), null,
    'an entry named after the one key a stamp map cannot keep, whose lookup answers with the prototype');
});
