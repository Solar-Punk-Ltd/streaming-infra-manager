import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, it } from 'node:test';

import { copyExecutionRoot } from '../../src/domain/versions/executionRootFiles.js';
import { inventoryOwnedTree, sha256 } from '../../src/domain/versions/ownedTreeInventory.js';

const commit = 'a'.repeat(40);
let root: string;
let source: string;
let executions: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 't04b-execution-files-'));
  source = join(root, 'bundled.builds', commit);
  executions = join(root, '.executions');
  await mkdir(join(source, 'deploy', 'scripts'), { recursive: true });
  await mkdir(join(source, 'engines', 'srs'), { recursive: true });
  await mkdir(executions, { mode: 0o700 });
  await writeFile(join(source, 'deploy', 'scripts', 'deploy.sh'), '#!/bin/sh\nexit 0\n');
  await chmod(join(source, 'deploy', 'scripts', 'deploy.sh'), 0o755);
  await writeFile(join(source, '.env.sample'), 'ENGINE=synthetic\n');
  await writeFile(join(source, 'deploy', 'config.sample.json'), '{}\n');
  await writeFile(join(source, 'engines', 'srs', '.env.sample'), 'SYNTHETIC=sample\n');
  await symlink('deploy/scripts/deploy.sh', join(source, 'entry'));
  await writeFile(join(source, '.stack-manifest.json'), JSON.stringify({ buildId: commit, commit, builtAt: '2026-09-09T00:00:00.000Z', toolchain: 'synthetic', inputGeneration: 1, inputHashes: {} }));
  await writeFile(join(source, '.complete'), '');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function treeDigest(path: string) {
  const { rootMode, entries } = await inventoryOwnedTree(path);
  return sha256(JSON.stringify({ format: 1, rootMode, entries }));
}
async function record() {
  const executionId = randomUUID();
  return {
    executionId, source: { root: source, versionId: 1, buildId: commit, commit, artifactDigest: await treeDigest(source) },
    profile: { name: 'owned', instanceId: randomUUID(), intentRevision: 3, status: 'DEPLOYING' as const },
    jobReferenceId: 7, target: { alias: 'localhost', daemonId: 'synthetic-daemon' }, project: 'owned', action: 'deploy' as const, services: ['srs'],
    root: join(executions, executionId, 'tree'), state: 'copying' as const, copyToken: randomUUID(), referenceId: 8, createdAt: new Date('2026-09-09T00:00:00.000Z'),
  };
}

it('copies the exact source to independent files and records ownership outside the writable tree', async () => {
  const item = await record();
  const before = await inventoryOwnedTree(source);
  await copyExecutionRoot(item, executions);
  assert.equal(await treeDigest(item.root), item.source.artifactDigest);
  assert.deepEqual(await inventoryOwnedTree(source), before);
  assert.notEqual((await lstat(join(item.root, 'deploy/scripts/deploy.sh'))).ino, (await lstat(join(source, 'deploy/scripts/deploy.sh'))).ino);
  assert.equal((await lstat(join(item.root, 'deploy/scripts/deploy.sh'))).mode & 0o777, 0o755);
  assert.equal(await readlink(join(item.root, 'entry')), 'deploy/scripts/deploy.sh');
  const owner = JSON.parse(await readFile(join(dirname(item.root), 'owner.json'), 'utf8'));
  assert.equal(owner.executionId, item.executionId);
  assert.equal(owner.copyToken, item.copyToken);
  assert.deepEqual(owner.source, item.source);
  assert.deepEqual(owner.profile, item.profile);
  assert.equal(owner.jobReferenceId, item.jobReferenceId);
  assert.equal((await lstat(dirname(item.root))).mode & 0o777, 0o700);
  assert.equal((await lstat(join(dirname(item.root), 'owner.json'))).mode & 0o777, 0o600);
});

it('copies a symbolic link as it stands, without touching the mode the platform gave it', async () => {
  // Linux reports every link as 0777 and macOS reports the umask, and neither is this copy's to set.
  const item = await record();
  const link = join(source, 'entry');
  const before = await lstat(link);

  await copyExecutionRoot(item, executions);

  const copied = join(item.root, 'entry');
  assert.equal(await readlink(copied), 'deploy/scripts/deploy.sh');
  assert.equal((await lstat(copied)).mode & 0o7777, before.mode & 0o7777);
});

it('contains manager env, engine env, deploy env and generated output writes without restoring absent base inputs', async () => {
  const item = await record();
  const before = await inventoryOwnedTree(source);
  await copyExecutionRoot(item, executions);
  for (const path of ['.env.owned', 'engines/srs/.env.owned', 'deploy/.env.deploy.owned', 'packages/stream-uploader/dist/index.js']) {
    await mkdir(dirname(join(item.root, path)), { recursive: true });
    await writeFile(join(item.root, path), 'synthetic runtime output');
  }
  for (const path of ['.env', 'deploy/config.json', 'engines/srs/.env']) {
    assert.equal(existsSync(join(source, path)), false);
    assert.equal(existsSync(join(item.root, path)), false);
  }
  assert.deepEqual(await inventoryOwnedTree(source), before);
});

for (const kind of ['empty-directory', 'nonempty-directory', 'file', 'symlink'] as const) {
  it(`does not replace an existing ${kind} ownership directory`, async () => {
    const item = await record();
    const destination = dirname(item.root);
    if (kind === 'file') await writeFile(destination, 'keep');
    else if (kind === 'symlink') await symlink(source, destination);
    else { await mkdir(destination); if (kind === 'nonempty-directory') await writeFile(join(destination, 'keep'), 'keep'); }
    const before = await lstat(destination);
    await assert.rejects(copyExecutionRoot(item, executions));
    assert.equal((await lstat(destination)).ino, before.ino);
  });
}

it('refuses duplicate copying of a previously completed private root', async () => {
  const item = await record();
  await copyExecutionRoot(item, executions);
  const before = await inventoryOwnedTree(item.root);
  await assert.rejects(copyExecutionRoot(item, executions));
  assert.deepEqual(await inventoryOwnedTree(item.root), before);
});

it('refuses a caller-selected path outside the configured UUID root', async () => {
  const item = await record();
  await assert.rejects(copyExecutionRoot({ ...item, root: join(root, 'unowned', 'tree') }, executions));
  assert.equal(existsSync(join(root, 'unowned')), false);
});

it('refuses a symlinked executions parent without writing through it', async () => {
  const item = await record();
  const alias = join(root, 'executions-alias');
  await symlink(executions, alias);
  await assert.rejects(copyExecutionRoot({ ...item, root: join(alias, item.executionId, 'tree') }, alias));
  assert.equal(existsSync(dirname(item.root)), false);
});

for (const change of ['digest', 'build', 'commit', 'state', 'token'] as const) {
  it(`refuses invalid ${change} evidence before creating a destination`, async () => {
    const item = await record();
    if (change === 'digest') item.source.artifactDigest = 'e'.repeat(64);
    if (change === 'build') item.source.buildId = `${commit}-r1`;
    if (change === 'commit') item.source.commit = 'b'.repeat(40);
    const input = change === 'state' ? { ...item, state: 'ready' as const } : change === 'token' ? { ...item, copyToken: null } : item;
    await assert.rejects(copyExecutionRoot(input, executions));
    assert.equal(existsSync(dirname(item.root)), false);
  });
}

it('refuses source bytes changing during copy and removes only its own partial destination', async () => {
  const item = await record();
  const unrelated = join(executions, randomUUID());
  await mkdir(unrelated);
  await writeFile(join(unrelated, 'keep'), 'keep');
  let changed = false;
  await assert.rejects(copyExecutionRoot(item, executions, { onProgress: async () => {
    if (!changed) { changed = true; await writeFile(join(source, 'deploy/scripts/deploy.sh'), 'changed'); }
  } }), /changed|digest|inventory/i);
  assert.equal(existsSync(dirname(item.root)), false);
  assert.equal(await readFile(join(unrelated, 'keep'), 'utf8'), 'keep');
});

it('captures descriptor values before copying so a caller mutation cannot change the selected source', async () => {
  const item = await record();
  const expected = structuredClone(item);
  await copyExecutionRoot(item, executions, { onProgress: async () => { item.source.artifactDigest = 'e'.repeat(64); } });
  assert.equal(await treeDigest(expected.root), expected.source.artifactDigest);
});

it('refuses a composed link escape without reading or modifying the sibling sentinel', async () => {
  const item = await record();
  await writeFile(join(dirname(source), 'outside.txt'), 'keep');
  await symlink('.', join(source, 'a'));
  await symlink('a/../outside.txt', join(source, 'b'));
  await assert.rejects(copyExecutionRoot(item, executions), /escape|link|changed|digest/i);
  assert.equal(await readFile(join(dirname(source), 'outside.txt'), 'utf8'), 'keep');
  assert.equal(existsSync(dirname(item.root)), false);
});
