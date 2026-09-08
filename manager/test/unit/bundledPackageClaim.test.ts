import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { claimBundledPackage, BUNDLED_CLAIM_PAYLOAD } from '../../src/domain/versions/bundledPackageClaim.js';
import { sealBundledPackage, type BundledShipmentIdentity } from '../../src/domain/versions/bundledShipmentPackage.js';
import { commitHostConfig } from '../../src/domain/versions/hostConfigCapture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bundled-claim-'));
  roots.push(root);
  const source = join(root, 'source');
  const ready = join(root, 'ready');
  await mkdir(source);
  await writeFile(join(source, 'main.js'), 'synthetic build');
  const revision = await commitHostConfig(source, { '.env': Buffer.from('ENGINE=synthetic\n') });
  const sealed = await sealBundledPackage(source, ready, {
    shipmentId: '2b9f7266-0191-4edc-80aa-6bb1575f9d7e',
    commit: 'a'.repeat(40),
    inputs: { generation: revision.generation, hashes: revision.files },
  });
  return { root, ready, identity: sealed.identity, claim: join(root, 'claim') };
}

test('takes exclusive ownership before verification and returns the moved verified package', async () => {
  const { ready, identity, claim } = await fixture();
  const result = await claimBundledPackage(ready, claim, identity);
  assert.equal(result.root, join(claim, BUNDLED_CLAIM_PAYLOAD));
  assert.deepEqual(result.identity, identity);
  await assert.rejects(lstat(ready));
  assert.equal(await readFile(join(result.root, 'main.js'), 'utf8'), 'synthetic build');
});

for (const sameDestination of [true, false]) {
  test(`two claimants have one winner with ${sameDestination ? 'one' : 'different'} claim paths`, async () => {
    const { root, ready, identity, claim } = await fixture();
    const other = sameDestination ? claim : join(root, 'other-claim');
    const results = await Promise.allSettled([
      claimBundledPackage(ready, claim, identity),
      claimBundledPackage(ready, other, identity),
    ]);
    const winners = results.filter(result => result.status === 'fulfilled');
    assert.equal(winners.length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    await assert.rejects(lstat(ready));
    const winner = winners[0]!;
    assert.equal(winner.status, 'fulfilled');
    assert.equal(await readFile(join(winner.value.root, 'main.js'), 'utf8'), 'synthetic build');
    const claimDirectories = (await readdir(root)).filter(path => path.endsWith('claim'));
    assert.equal(claimDirectories.length, 1, 'a losing empty claim directory is removed without touching the winner');
  });
}

test('never overwrites an existing claim and refuses it before inspecting a malformed ready package', async () => {
  const { ready, identity, claim } = await fixture();
  await mkdir(claim);
  await writeFile(join(claim, 'keep'), 'other owner');
  await rm(ready, { recursive: true });
  await writeFile(ready, 'not a package');
  await assert.rejects(claimBundledPackage(ready, claim, identity), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === 'EEXIST');
  assert.equal(await readFile(join(claim, 'keep'), 'utf8'), 'other owner');
  assert.equal(await readFile(ready, 'utf8'), 'not a package');
});

test('retains its claimed payload after failed verification and does not put it back for another claimant', async () => {
  const { ready, identity, claim } = await fixture();
  await writeFile(join(ready, 'main.js'), 'changed after upload');
  await assert.rejects(claimBundledPackage(ready, claim, identity), /inventory/);
  await assert.rejects(lstat(ready));
  assert.equal(await readFile(join(claim, BUNDLED_CLAIM_PAYLOAD, 'main.js'), 'utf8'), 'changed after upload');
});

test('requires the complete expected identity before taking ownership', async () => {
  for (const missing of ['shipmentId', 'commit', 'digest'] as const) {
    const { ready, identity, claim } = await fixture();
    const incomplete: Partial<BundledShipmentIdentity> = { ...identity };
    delete incomplete[missing];
    await assert.rejects(claimBundledPackage(ready, claim, incomplete as BundledShipmentIdentity), /identity|manifest/);
    assert.equal((await lstat(ready)).isDirectory(), true);
    await assert.rejects(lstat(claim));
  }
});

test('does not accept a finalized package with a different expected digest', async () => {
  const { ready, identity, claim } = await fixture();
  await assert.rejects(claimBundledPackage(ready, claim, { ...identity, digest: '0'.repeat(64) }), /identity/);
  assert.equal((await lstat(join(claim, BUNDLED_CLAIM_PAYLOAD))).isDirectory(), true);
});

test('does not follow a ready-root symlink into another package after claiming it', async () => {
  const { root, ready, identity, claim } = await fixture();
  const linkedReady = join(root, 'linked-ready');
  await symlink(ready, linkedReady);
  await assert.rejects(claimBundledPackage(linkedReady, claim, identity), /symbolic/);
  assert.equal((await lstat(join(claim, BUNDLED_CLAIM_PAYLOAD))).isSymbolicLink(), true);
  assert.equal(await readFile(join(ready, 'main.js'), 'utf8'), 'synthetic build');
});

test('cleans only its newly reserved empty claim directory when the ready path is missing', async () => {
  const { root, ready, identity, claim } = await fixture();
  await rm(ready, { recursive: true });
  await writeFile(join(root, 'keep'), 'other owner');
  await assert.rejects(claimBundledPackage(ready, claim, identity), (error: unknown) =>
    (error as NodeJS.ErrnoException).code === 'ENOENT');
  await assert.rejects(lstat(claim));
  assert.equal(await readFile(join(root, 'keep'), 'utf8'), 'other owner');
});
