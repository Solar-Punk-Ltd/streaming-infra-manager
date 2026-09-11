import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { EventBus } from '../../src/domain/EventBus.js';
import { StackVersionService } from '../../src/domain/versions/StackVersionService.js';
import { readStackContract } from '../../src/domain/versions/stackContract.js';
import { FakeScriptSpawner } from '../support/FakeScriptSpawner.js';
import { InMemoryStackVersionRepository } from '../support/InMemoryStackVersionRepository.js';
import { V3_FIXTURE } from '../support/stackFixtures.js';

const A = 'a'.repeat(40); const B = 'b'.repeat(40); const C = 'c'.repeat(40);
describe('bundled boot never invents shipment publication authority', () => {
  let root: string; let versionsRoot: string; let legacyRoot: string;
  let versions: InMemoryStackVersionRepository; let service: StackVersionService;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 't04b-boot-authority-'));
    versionsRoot = join(root, 'versions'); legacyRoot = join(root, 'legacy');
    await mkdir(versionsRoot); await cp(V3_FIXTURE, legacyRoot, { recursive: true });
    versions = new InMemoryStackVersionRepository(); versions.seedBundled();
    service = new StackVersionService(versions, new FakeScriptSpawner(), new EventBus(), versionsRoot, {
      openReferences: async () => [],
    }, legacyRoot);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  async function artifact(commit: string) {
    const path = join(versionsRoot, 'bundled.builds', commit);
    await cp(V3_FIXTURE, path, { recursive: true });
    await writeFile(join(path, '.complete'), '');
    await writeFile(join(path, '.stack-manifest.json'), JSON.stringify({ buildId: commit, commit,
      builtAt: '2099-01-01T00:00:00Z', toolchain: 'synthetic' }));
    return path;
  }
  async function activeC() {
    await artifact(C);
    const bundled = (await versions.findByName('bundled'))!;
    await versions.publish(bundled.id, { buildId: C, commitSha: C, rootPath: join(versionsRoot, 'bundled'), contract: readStackContract(legacyRoot) });
    return (await versions.findByName('bundled'))!;
  }
  it('does not adopt an unreferenced artifact with a newer timestamp after C is active', async () => {
    const before = await activeC(); const old = await artifact(A);
    const bytes = await readFile(join(old, '.stack-manifest.json'));
    await service.syncBundled(legacyRoot, B);
    const after = (await versions.findByName('bundled'))!;
    assert.equal(after.buildId, before.buildId);
    assert.equal(after.commitSha, before.commitSha);
    assert.deepEqual(await readFile(join(old, '.stack-manifest.json')), bytes);
  });
  it('does not publish or consume an unregistered stable incoming directory', async () => {
    const before = await activeC(); const incoming = join(versionsRoot, 'bundled.incoming');
    await cp(V3_FIXTURE, incoming, { recursive: true });
    await writeFile(join(incoming, '.stack-commit'), `${A}\n`);
    const env = (await readFile(join(incoming, '.env.sample'), 'utf8')).replace('API_AUTH_TOKEN=', 'API_AUTH_TOKEN=synthetic');
    await writeFile(join(incoming, '.env'), env);
    await service.syncBundled(legacyRoot, B);
    assert.equal((await versions.findByName('bundled'))!.buildId, before.buildId);
    assert.equal(await readFile(join(incoming, '.env'), 'utf8'), env);
    assert.deepEqual(await readdir(join(versionsRoot, 'bundled.builds')), [C]);
  });
  it('does not create missing runtime defaults in the legacy tree during boot', async () => {
    const before = (await readdir(legacyRoot)).sort();
    await service.syncBundled(legacyRoot, A);
    assert.deepEqual((await readdir(legacyRoot)).sort(), before);
    assert.equal((await versions.findByName('bundled'))!.layout, 'legacy');
  });
});
