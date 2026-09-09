import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { commitHostConfig } from '../../src/domain/versions/hostConfigCapture.js';
import {
  BUNDLED_PACKAGE_MANIFEST,
  sealBundledPackage,
  verifyBundledPackage,
  type BundledPackageManifest,
} from '../../src/domain/versions/bundledShipmentPackage.js';

const shipmentId = '2b9f7266-0191-4edc-80aa-6bb1575f9d7e';
const commit = 'a'.repeat(40);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bundled-package-'));
  roots.push(root);
  const source = join(root, 'built');
  await mkdir(join(source, 'dist'), { recursive: true });
  await writeFile(join(source, 'dist', 'main.js'), 'built from A\n');
  await chmod(join(source, 'dist', 'main.js'), 0o755);
  await mkdir(join(source, 'empty'));
  await symlink('dist/main.js', join(source, 'entry'));
  const revision = await commitHostConfig(source, {
    '.env': Buffer.from('ENGINE=synthetic\n'),
    'deploy/config.json': Buffer.from('{"revision":"A"}\n'),
  });
  return { root, source, output: join(root, 'sealed'), capture: { shipmentId, commit, inputs: { generation: revision.generation, hashes: revision.files } } };
}

test('seals and verifies the exact path, type, permission, content and copied-input pair', async () => {
  const { source, output, capture } = await fixture();
  const sealed = await sealBundledPackage(source, output, capture);
  const verified = await verifyBundledPackage(output, sealed.identity);
  assert.deepEqual(verified.identity, sealed.identity);
  assert.deepEqual(verified.manifest.inputs, capture.inputs);
  assert.equal(verified.manifest.commit, commit);
  assert.equal(verified.manifest.shipmentId, shipmentId);
  assert.equal(await readFile(join(output, 'dist/main.js'), 'utf8'), 'built from A\n');
  assert.equal((await lstat(join(output, 'dist/main.js'))).mode & 0o777, 0o755);
  assert.equal(await readlink(join(output, 'entry')), 'dist/main.js');
  assert.equal((await lstat(join(output, 'empty'))).isDirectory(), true);
  const { digest, ...payload } = verified.manifest;
  assert.equal(digest, createHash('sha256').update(JSON.stringify(payload)).digest('hex'));
  assert.equal(payload.entries.some(entry => entry.path === BUNDLED_PACKAGE_MANIFEST), false);
  assert.equal((await lstat(join(output, BUNDLED_PACKAGE_MANIFEST))).mode & 0o777, 0o600);
});

test('records a symbolic link with the one mode every platform gives one, so a package travels', async () => {
  const { source, output, capture } = await fixture();

  const sealed = await sealBundledPackage(source, output, capture);

  const verified = await verifyBundledPackage(output, sealed.identity);
  const link = verified.manifest.entries.find(entry => entry.path === 'entry');
  assert.equal(link?.type, 'symlink');
  // Linux gives every symbolic link 0777 and offers no way to change it, so that is what a package records.
  assert.equal(link?.mode, 0o777);
});

test('produces the same identity from the same tree independently of destination and wall time', async () => {
  const { root, source, output, capture } = await fixture();
  const first = await sealBundledPackage(source, output, capture);
  const second = await sealBundledPackage(source, join(root, 'second'), capture);
  assert.deepEqual(first.identity, second.identity);
});

const mutations = {
  content: async (root: string) => writeFile(join(root, 'dist/main.js'), 'different built bytes\n'),
  mode: async (root: string) => chmod(join(root, 'dist/main.js'), 0o644),
  directory_mode: async (root: string) => chmod(join(root, 'empty'), 0o700),
  root_mode: async (root: string) => chmod(root, 0o700),
  added: async (root: string) => writeFile(join(root, 'unexpected'), 'extra'),
  removed: async (root: string) => rm(join(root, 'dist/main.js')),
  type: async (root: string) => { await rm(join(root, 'dist/main.js')); await mkdir(join(root, 'dist/main.js')); },
  link: async (root: string) => { await rm(join(root, 'entry')); await symlink('deploy/config.json', join(root, 'entry')); },
  manifest_mode: async (root: string) => chmod(join(root, BUNDLED_PACKAGE_MANIFEST), 0o644),
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`refuses a package whose ${name} changed after sealing`, async () => {
    const { source, output, capture } = await fixture();
    await chmod(source, 0o755);
    const sealed = await sealBundledPackage(source, output, capture);
    await mutate(output);
    await assert.rejects(verifyBundledPackage(output, sealed.identity), /package|manifest|inventory|changed/i);
  });
}

test('rejects mismatched expected shipment, commit or digest rather than trusting a finalized manifest', async () => {
  const { source, output, capture } = await fixture();
  const sealed = await sealBundledPackage(source, output, capture);
  for (const changed of [{ shipmentId: '3b9f7266-0191-4edc-80aa-6bb1575f9d7e' }, { commit: 'b'.repeat(40) }, { digest: '0'.repeat(64) }]) {
    await assert.rejects(verifyBundledPackage(output, { ...sealed.identity, ...changed }), /identity/i);
  }
  await rm(join(output, 'dist'), { recursive: true });
  await assert.rejects(verifyBundledPackage(output, sealed.identity), /inventory|package/i);
});

test('rejects a copied input pair that does not match both the revision and actual complete file set', async () => {
  for (const mismatch of ['generation', 'hash', 'missing', 'extra'] as const) {
    const { source, output, capture } = await fixture();
    if (mismatch === 'generation') capture.inputs.generation += 1;
    if (mismatch === 'hash') capture.inputs.hashes['.env'] = '0'.repeat(64);
    if (mismatch === 'missing') delete capture.inputs.hashes['.env'];
    if (mismatch === 'extra') await writeFile(join(source, 'engines.extra'), 'ordinary application file');
    if (mismatch === 'extra') {
      await mkdir(join(source, 'engines', 'new'), { recursive: true });
      await writeFile(join(source, 'engines', 'new', '.env'), 'ENGINE=new\n');
    }
    await assert.rejects(sealBundledPackage(source, output, capture), /input|revision/i);
  }
});

test('refuses changing source bytes while copying and removes only its own failed package', async () => {
  const { root, source, output, capture } = await fixture();
  const sentinel = join(root, 'keep');
  await writeFile(sentinel, 'unrelated');
  let changed = false;
  await assert.rejects(sealBundledPackage(source, output, capture, {
    onProgress: async () => {
      if (!changed) { changed = true; await writeFile(join(source, 'dist/main.js'), 'built from B\n'); }
    },
  }), /source.*changed/i);
  assert.equal(changed, true);
  await assert.rejects(lstat(output));
  assert.equal(await readFile(sentinel, 'utf8'), 'unrelated');
});

test('does not overwrite an existing destination or seal over its own source', async () => {
  const { source, output, capture } = await fixture();
  await mkdir(output);
  await writeFile(join(output, 'keep'), 'other attempt');
  await assert.rejects(sealBundledPackage(source, output, capture), /exist/i);
  assert.equal(await readFile(join(output, 'keep'), 'utf8'), 'other attempt');
  await assert.rejects(sealBundledPackage(source, source, capture), /separate/i);
});

test('refuses external and composed escaping links without copying their targets', async () => {
  for (const composed of [false, true]) {
    const { root, source, output, capture } = await fixture();
    await writeFile(join(root, 'outside.txt'), 'sibling sentinel');
    if (composed) await symlink('.', join(source, 'a'));
    await symlink(composed ? 'a/../outside.txt' : '../outside.txt', join(source, 'escape'));
    await assert.rejects(sealBundledPackage(source, output, capture), /escapes/i);
    assert.equal(await readFile(join(root, 'outside.txt'), 'utf8'), 'sibling sentinel');
  }
});

test('rejects traversal, absolute or self-inventory paths even with a recomputed manifest digest', async () => {
  for (const path of ['../outside', '/absolute', BUNDLED_PACKAGE_MANIFEST]) {
    const { source, output, capture } = await fixture();
    const sealed = await sealBundledPackage(source, output, capture);
    const manifest = JSON.parse(await readFile(join(output, BUNDLED_PACKAGE_MANIFEST), 'utf8')) as BundledPackageManifest;
    manifest.entries[0]!.path = path;
    const { digest: _oldDigest, ...payload } = manifest;
    manifest.digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await writeFile(join(output, BUNDLED_PACKAGE_MANIFEST), JSON.stringify(manifest));
    await assert.rejects(verifyBundledPackage(output, { ...sealed.identity, digest: manifest.digest }), /path|inventory|manifest/i);
  }
});

test('rejects a source containing a pre-existing package manifest', async () => {
  const { source, output, capture } = await fixture();
  await writeFile(join(source, BUNDLED_PACKAGE_MANIFEST), '{}');
  await assert.rejects(sealBundledPackage(source, output, capture), /manifest/i);
});
