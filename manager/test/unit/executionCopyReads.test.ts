/**
 * What one prepare-and-copy costs the build it reads, and what still guards it.
 *
 * Preparing the private copy a deploy runs from used to read and hash the whole
 * build tree four times over and then copy it, all awaited inside the HTTP
 * request that creates the deployment. A build is now hashed once for its whole
 * life, into a record beside it, hard linked rather than written, and the
 * proofs that it has not moved since compare the stamps that record holds
 * instead of reading it again.
 *
 * Three things have to hold together, so all three are here. The build is read
 * once and never again. A build that changes in the window between the
 * inventory and the copy is still refused, and so is one that changed after the
 * record was taken. The last is the one a stamp comparison could quietly lose:
 * a file added after the inventory is linked by nobody and missed by every
 * digest, because the copy and its digest are both made from the inventory
 * itself.
 *
 * Unit test, no database and no Docker, but the copies are real files.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, it } from 'node:test';

import { Logger } from '../../src/domain/Logger.js';
import type { ExecutionRootRecord } from '../../src/domain/versions/ExecutionRoot.js';
import { ExecutionRootService, PROGRESS_FLOOR, type ExecutionPreparation } from '../../src/domain/versions/ExecutionRootService.js';
import { BUILD_COMPLETE_MARKER, BUILD_MANIFEST_FILE } from '../../src/domain/versions/buildManifest.js';
import { inventoryOwnedTree, stampOwnedTree } from '../../src/domain/versions/ownedTreeInventory.js';
import { InMemoryExecutionRoots } from '../support/InMemoryExecutionRoots.js';

/**
 * One inventory of the build. The copy links the bytes rather than reading
 * them, and the inventory of the finished copy reaches the same inodes through
 * the copy's own paths rather than the build's.
 */
const READS_PER_PREPARE = 1;
/** Read once more on their own to prove the build identity, which is two files rather than a pass over the tree. */
const IDENTITY_FILES: string[] = [BUILD_MANIFEST_FILE, BUILD_COMPLETE_MARKER];

const commit = 'a'.repeat(40);
let root: string;
let build: string;
let executions: string;
beforeEach(async () => {
  root = await fsPromises.mkdtemp(join(tmpdir(), 'execution-copy-reads-'));
  build = join(root, 'builds', commit);
  executions = join(root, '.executions');
  await fsPromises.mkdir(join(build, 'deploy', 'scripts'), { recursive: true });
  await fsPromises.mkdir(executions, { mode: 0o700 });
  await fsPromises.writeFile(join(build, 'deploy', 'scripts', 'deploy.sh'), '#!/bin/sh\nexit 0\n');
  await fsPromises.writeFile(join(build, '.env.sample'), 'ENGINE=synthetic\n');
  await fsPromises.symlink('deploy/scripts/deploy.sh', join(build, 'entry'));
  await fsPromises.writeFile(join(build, BUILD_MANIFEST_FILE), JSON.stringify({ buildId: commit, commit, builtAt: '2026-09-09T00:00:00.000Z', toolchain: 'synthetic' }));
  await fsPromises.writeFile(join(build, BUILD_COMPLETE_MARKER), '');
});
afterEach(async () => { await fsPromises.rm(root, { recursive: true, force: true }); });

const storeFor = () => new InMemoryExecutionRoots(executions, () => randomUUID());
const preparation = (jobReferenceId = 7): ExecutionPreparation => ({
  profile: { name: 'owned', instanceId: randomUUID(), intentRevision: 3, status: 'DEPLOYING' },
  build: { versionId: 1, buildId: commit, root: build, layout: 'builds' },
  jobReferenceId,
  target: { alias: 'localhost', daemonId: 'synthetic-daemon' },
  services: [],
});

/** The window this is about: prepare inventories the build, then the copy starts once the token is taken. */
function changeWhenTheCopyTakesItsToken(store: InMemoryExecutionRoots, change: () => Promise<void>): void {
  const beginCopy = store.beginCopy.bind(store);
  store.beginCopy = async (id: string): Promise<ExecutionRootRecord | null> => {
    const record = await beginCopy(id);
    await change();
    return record;
  };
}

it('stamps the paths an inventory stamps, so a later comparison is of like with like', async () => {
  const inventory = await inventoryOwnedTree(build, BUILD_COMPLETE_MARKER);

  assert.deepEqual(await stampOwnedTree(build, BUILD_COMPLETE_MARKER), inventory.stamps);
});

it('reads each file of the build once for one prepare and copy, not once for every proof', async t => {
  const opened = t.mock.method(fsPromises, 'open');
  syncBuiltinESMExports();
  t.after(() => { opened.mock.restore(); syncBuiltinESMExports(); });

  await new ExecutionRootService(storeFor(), executions).prepare(preparation());

  const reads = new Map<string, number>();
  for (const call of opened.mock.calls) {
    const path = String(call.arguments[0]);
    if (!path.startsWith(`${build}/`)) continue;
    const inTree = path.slice(build.length + 1);
    if (!IDENTITY_FILES.includes(inTree)) reads.set(inTree, (reads.get(inTree) ?? 0) + 1);
  }
  assert.ok(reads.size > 0, 'no read of the build was seen at all, so this test counts nothing');
  const most = Math.max(...reads.values());
  assert.ok(most <= READS_PER_PREPARE, `one prepare and copy read a file of the build ${most} times: ${
    [...reads].filter(([, count]) => count === most).map(([path]) => path).join(', ')}`);
});

for (const change of ['is rewritten', 'gains a file nothing inventoried'] as const) {
  it(`refuses a build that ${change} between its inventory and the links made from it`, async () => {
    const store = storeFor();
    changeWhenTheCopyTakesItsToken(store, () => change === 'is rewritten'
      ? fsPromises.writeFile(join(build, '.env.sample'), 'ENGINE=synthetic-and-changed\n')
      : fsPromises.writeFile(join(build, 'deploy', 'late.txt'), 'arrived after the inventory\n'));

    await assert.rejects(new ExecutionRootService(store, executions).prepare(preparation()), /changed/);

    assert.deepEqual(await fsPromises.readdir(executions), [], 'the copy of a refused build was left behind');
  });
}

/** The reads of the build one call made, by path inside it. */
function readsOfTheBuild(opened: { mock: { calls: { arguments: unknown[] }[] } }): Map<string, number> {
  const reads = new Map<string, number>();
  for (const call of opened.mock.calls) {
    const path = String(call.arguments[0]);
    if (!path.startsWith(`${build}/`)) continue;
    const inTree = path.slice(build.length + 1);
    reads.set(inTree, (reads.get(inTree) ?? 0) + 1);
  }
  return reads;
}

it('hashes a build once ever, and answers every later copy from the record beside it', async t => {
  const opened = t.mock.method(fsPromises, 'open');
  syncBuiltinESMExports();
  t.after(() => { opened.mock.restore(); syncBuiltinESMExports(); });
  const service = new ExecutionRootService(storeFor(), executions);

  await service.prepare(preparation(7));
  const first = readsOfTheBuild(opened);
  opened.mock.resetCalls();
  await service.prepare(preparation(8));
  const second = readsOfTheBuild(opened);

  assert.ok(first.size > IDENTITY_FILES.length, 'the first prepare never read the build, so this test counts nothing');
  assert.deepEqual([...second.keys()].sort(), [...IDENTITY_FILES].sort(),
    'a second copy of the same build read more of it than the two files that say which build it is');
  assert.equal((await fsPromises.lstat(`${build}.inventory.json`)).mode & 0o7777, 0o600);
});

for (const change of ['bytes', 'mode'] as const) {
  it(`refuses a build whose ${change} changed after it was inventoried`, async () => {
    const service = new ExecutionRootService(storeFor(), executions);
    await service.prepare(preparation(7));
    const path = join(build, '.env.sample');

    if (change === 'bytes') await fsPromises.writeFile(path, 'ENGINE=synthetic-and-changed\n');
    else await fsPromises.chmod(path, 0o600);

    await assert.rejects(service.prepare(preparation(8)), /changed/);
  });
}

it('says which build it is copying and how far it has got', async t => {
  const said: string[] = [];
  t.mock.method(Logger.prototype, 'info', (...args: unknown[]) => { said.push(args.join(' ')); });
  for (let index = 0; index < PROGRESS_FLOOR; index += 1) {
    await fsPromises.writeFile(join(build, `page-${index}.txt`), `${index}\n`);
  }
  const files = PROGRESS_FLOOR + 4;

  await new ExecutionRootService(storeFor(), executions).prepare(preparation());

  assert.ok(said.some(line => new RegExp(`inventoried build ${commit} once, ${files} files`).test(line)), said.join('\n'));
  assert.ok(said.some(line => new RegExp(`preparing a copy of build ${commit}, ${files} files`).test(line)), said.join('\n'));
  assert.ok(said.filter(line => /linked \d+ of \d+ files/.test(line)).length > 1, said.join('\n'));
});

it('takes a fresh inventory when the build under the record was rebuilt at the same id', async () => {
  // A pruned build's record stays beside the builds, and a rollback gets the same id back from freeBuildId.
  const service = new ExecutionRootService(storeFor(), executions);
  await service.prepare(preparation(7));
  const stale = await fsPromises.readFile(`${build}.inventory.json`, 'utf8');

  await fsPromises.rm(build, { recursive: true, force: true });
  await fsPromises.mkdir(join(build, 'deploy', 'scripts'), { recursive: true });
  await fsPromises.writeFile(join(build, 'deploy', 'scripts', 'deploy.sh'), '#!/bin/sh\nexit 1\n');
  await fsPromises.writeFile(join(build, BUILD_MANIFEST_FILE), JSON.stringify({ buildId: commit, commit, builtAt: '2026-09-17T00:00:00.000Z', toolchain: 'synthetic' }));
  await fsPromises.writeFile(join(build, BUILD_COMPLETE_MARKER), '');

  const prepared = await service.prepare(preparation(8));

  assert.ok(prepared, 'the rebuilt build was refused, so its id can never be deployed again');
  assert.notEqual(await fsPromises.readFile(`${build}.inventory.json`, 'utf8'), stale, 'the record still describes the build that is gone');
});
