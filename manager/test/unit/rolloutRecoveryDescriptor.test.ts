import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { captureRolloutRecovery, parseRolloutRecoveryDescriptor, validateCapturedRecovery } from '../../src/domain/engineConfig/rolloutRecoveryDescriptor.js';
import { BUILD_COMPLETE_MARKER, BUILD_MANIFEST_FILE } from '../../src/domain/versions/buildManifest.js';
import { inventoryOwnedTree, sha256 } from '../../src/domain/versions/ownedTreeInventory.js';
import { buildDirFor } from '../../src/domain/versions/stackPaths.js';
import { copyExecutionRoot } from '../../src/domain/versions/executionRootFiles.js';
import type { StackVersionRecord } from '../../src/domain/versions/StackVersionRepository.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

const A = 'a'.repeat(40);
describe('captured config rollback artifact evidence', () => {
  let parent: string;
  let artifact: string;
  let version: StackVersionRecord;
  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 't01-recovery-descriptor-'));
    artifact = buildDirFor(parent, 'source-stack', A);
    await mkdir(artifact, { recursive: true });
    await writeFile(join(artifact, BUILD_MANIFEST_FILE), JSON.stringify({ commit: A, buildId: A, builtAt: '2026-01-01T00:00:00Z', toolchain: 'synthetic' }));
    await writeFile(join(artifact, BUILD_COMPLETE_MARKER), '');
    await writeFile(join(artifact, 'source.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await symlink('source.sh', join(artifact, 'internal-link'));
    version = { id: 9, name: 'source-stack', gitRef: 'synthetic', rootPath: join(parent, 'source-stack'), layout: 'builds', buildId: A,
      previousBuildId: null, commitSha: A, contract: ALLOCATION_CONTRACT, status: 'ready', isDefault: false, tested: false,
      createdAt: new Date(0), builtAt: new Date(0), lastError: null };
  });
  afterEach(async () => { if (parent) await rm(parent, { recursive: true, force: true }); });

  it('captures path, type, mode and content identity including internal links and generated evidence files', async () => {
    const captured = await captureRolloutRecovery(version, parent);
    assert.equal(captured.kind, 'immutable-build');
    if (captured.kind !== 'immutable-build') throw new Error('immutable evidence required');
    const inventory = await inventoryOwnedTree(artifact);
    assert.equal(captured.artifactDigest, sha256(JSON.stringify({ format: 1, rootMode: inventory.rootMode, entries: inventory.entries })));
    assert.equal(captured.manifestHash, sha256(await readFile(join(artifact, BUILD_MANIFEST_FILE))));
    assert.equal(captured.completeHash, sha256(''));
    assert.deepEqual(parseRolloutRecoveryDescriptor(JSON.parse(JSON.stringify(captured))), captured);
    assert.doesNotThrow(() => validateCapturedRecovery(captured, version, parent));
    await chmod(join(artifact, 'source.sh'), 0o644);
    assert.notEqual((await captureRolloutRecovery(version, parent)).artifactDigest, captured.artifactDigest);
  });

  it('refuses source mutation between its complete inventories', async () => {
    await assert.rejects(captureRolloutRecovery(version, parent, { afterInventory: async () => {
      await writeFile(join(artifact, 'source.sh'), 'synthetic changed source');
    } }), /changed/i);
  });

  it('uses recovery evidence directly as the execution copy source digest without changing format', async () => {
    const captured = await captureRolloutRecovery(version, parent);
    if (captured.kind !== 'immutable-build') throw new Error('immutable evidence required');
    const executions = join(parent, '.executions');
    await mkdir(executions);
    const executionId = randomUUID();
    const result = await copyExecutionRoot({ executionId,
      source: { versionId: version.id, root: artifact, buildId: A, commit: A, artifactDigest: captured.artifactDigest },
      profile: { name: 'synthetic-owner', instanceId: randomUUID(), intentRevision: 1, status: 'DEPLOYING' },
      jobReferenceId: 9, target: { alias: 'localhost', daemonId: 'synthetic-daemon' }, project: 'synthetic-owner', action: 'deploy', services: ['srs'],
      root: join(executions, executionId, 'tree'), state: 'copying', copyToken: randomUUID(), referenceId: 10, createdAt: new Date(0),
    }, executions);
    assert.equal(result.artifactDigest, captured.artifactDigest);
    assert.equal(await readFile(join(result.root, 'source.sh'), 'utf8'), await readFile(join(artifact, 'source.sh'), 'utf8'));
  });

  it('refuses a disappearing source during capture', async () => {
    await assert.rejects(captureRolloutRecovery(version, parent, { afterInventory: async () => {
      await rm(artifact, { recursive: true });
    } }));
  });

  for (const file of [BUILD_MANIFEST_FILE, BUILD_COMPLETE_MARKER]) {
    it(`refuses a symbolic-link ${file} even when its bytes are inside the owned tree`, async () => {
      const original = await readFile(join(artifact, file));
      await writeFile(join(artifact, 'inside-evidence'), original);
      await rm(join(artifact, file));
      await symlink('inside-evidence', join(artifact, file));
      await assert.rejects(captureRolloutRecovery(version, parent), /regular|link/i);
    });
    it(`refuses oversized ${file} evidence`, async () => {
      await writeFile(join(artifact, file), 'x'.repeat(1024 * 1024));
      await assert.rejects(captureRolloutRecovery(version, parent), /large|bound|limit/i);
    });
  }

  it('refuses composed symbolic-link traversal outside the source tree', async () => {
    await symlink('.', join(artifact, 'a'));
    await symlink('a/../outside.txt', join(artifact, 'b'));
    await assert.rejects(captureRolloutRecovery(version, parent), /escapes/i);
  });

  it('refuses a build root outside the configured version parent', async () => {
    await assert.rejects(captureRolloutRecovery({ ...version, rootPath: join(parent, 'elsewhere', version.name) }, parent), /root|parent/i);
  });

  it('refuses a malformed name before inventory can reach a sibling artifact', async () => {
    const configured = join(parent, 'versions');
    await mkdir(configured);
    const sentinel = await readFile(join(artifact, 'source.sh'), 'utf8');
    let inventoriedSibling = false;
    await assert.rejects(captureRolloutRecovery({ ...version, name: '../source-stack' }, configured, {
      afterInventory: async () => { inventoriedSibling = true; },
    }), /descriptor|name/i);
    assert.equal(inventoriedSibling, false, 'malformed identity must be rejected before any sibling inventory');
    assert.equal(await readFile(join(artifact, 'source.sh'), 'utf8'), sentinel);
    assert.equal((await captureRolloutRecovery(version, parent)).kind, 'immutable-build');
  });

  it('rejects invalid version identity before trying to read missing evidence', async () => {
    await rm(join(artifact, BUILD_MANIFEST_FILE));
    await assert.rejects(captureRolloutRecovery({ ...version, id: -1 }, parent), /Invalid rollout recovery descriptor/);
  });

  it('parses the bounded manifest bytes without reopening a replaced path under admission locks', async t => {
    const captured = await captureRolloutRecovery(version, parent);
    const manifestPath = join(artifact, BUILD_MANIFEST_FILE);
    const sibling = join(parent, 'synthetic-replacement.json');
    await writeFile(sibling, JSON.stringify({ commit: 'b'.repeat(40), buildId: 'b'.repeat(40), builtAt: '2026-01-01', toolchain: 'synthetic' }));
    const originalClose = fs.closeSync;
    const originalRead = fs.readFileSync;
    let replaced = false;
    let manifestReopens = 0;
    let failure: unknown;
    t.mock.method(fs, 'closeSync', (fd: number) => {
      originalClose(fd);
      if (!replaced) {
        replaced = true;
        fs.unlinkSync(manifestPath);
        fs.symlinkSync(sibling, manifestPath);
      }
    });
    t.mock.method(fs, 'readFileSync', ((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === manifestPath) manifestReopens++;
      return Reflect.apply(originalRead, fs, args);
    }) as typeof fs.readFileSync);
    try {
      syncBuiltinESMExports();
      try { validateCapturedRecovery(captured, version, parent); } catch (error) { failure = error; }
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.equal(replaced, true);
    assert.equal(manifestReopens, 0, 'the manifest identity must come from the bytes whose hash was captured');
    assert.equal(failure, undefined);
  });

  it('checks selected identity again rather than accepting another version with identical file bytes', async () => {
    const captured = await captureRolloutRecovery(version, parent);
    assert.throws(() => validateCapturedRecovery(captured, { ...version, id: version.id + 1 }, parent), /identity|changed/i);
  });

  for (const rootPath of [null, '/synthetic/mutable-legacy']) {
    it(`records legacy ${rootPath === null ? 'bundled' : 'flat-root'} facts without a digest or filesystem proof`, async () => {
      const captured = await captureRolloutRecovery({ ...version, rootPath, layout: 'legacy', buildId: null }, parent);
      assert.equal(captured.kind, 'legacy-unproven');
      assert.equal(captured.artifactDigest, undefined);
      assert.deepEqual(parseRolloutRecoveryDescriptor(JSON.parse(JSON.stringify(captured))), captured);
    });
  }

  it('keeps historical null distinct and rejects malformed or falsely promoted evidence', async () => {
    assert.equal(parseRolloutRecoveryDescriptor(null), null);
    const captured = await captureRolloutRecovery(version, parent);
    for (const changed of [
      { ...captured, format: 99 },
      { ...captured, artifactDigest: null },
      { ...captured, arbitraryFileExclusion: ['source.sh'] },
      { ...captured, kind: 'legacy-unproven', reason: 'mutable-legacy-source' },
      { ...captured, version: { ...captured.version, layout: 'legacy' } },
      { ...captured, version: { ...captured.version, buildId: '../escape' } },
    ]) assert.throws(() => parseRolloutRecoveryDescriptor(changed), /recovery|descriptor/i);
  });
});
