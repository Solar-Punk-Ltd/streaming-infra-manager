/**
 * What prune may delete: a build nothing protects, and nothing else.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * Prune keeps the version's current and previous builds, every build an
 * unresolved job reference names, and every build a snapshot reference
 * names, and deletes the other build directories under the builds root. It
 * never touches an attempt's staging directory, which is boot's, a
 * directory that is not a build, or the flat root, which keeps the
 * host-owned inputs.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import type { StackContract } from '@streaming-infra-manager/common';

import { EventBus } from '../../src/domain/EventBus.js';
import type { BuildReference } from '../../src/domain/versions/buildReferences.js';
import { buildDirFor, buildsRootFor } from '../../src/domain/versions/stackPaths.js';
import { StackVersionService } from '../../src/domain/versions/StackVersionService.js';
import { FakeScriptSpawner } from '../support/FakeScriptSpawner.js';
import { InMemoryStackVersionRepository } from '../support/InMemoryStackVersionRepository.js';

const CONTRACT: StackContract = {
  ports: [],
  maxSlot: 99,
  requiredSecrets: [],
  engineDefaults: {},
  features: { srsApiPort: true, chequebookGate: false, sharedImageTags: true },
  chequebookMinBzz: null,
  engineConfig: { srs: true, ome: false },
  engineImages: { srs: 'ossrs/srs:6', ome: null },
  warnings: [],
  allocationProblem: null,
};

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const E = 'e'.repeat(40);

let versionsRoot: string;
let repository: InMemoryStackVersionRepository;
let references: BuildReference[];
let service: StackVersionService;
let versionId: number;

const at = (seconds: number) => new Date(seconds * 1000);

function reference(over: Partial<BuildReference> & Pick<BuildReference, 'id' | 'holderKind' | 'buildId'>): BuildReference {
  return { versionId, holderId: 'stage', services: ['srs'], createdAt: at(1), resolvedAt: null, ...over };
}

function buildOnDisk(buildId: string): void {
  const dir = buildDirFor(versionsRoot, 'v3', buildId);
  mkdirSync(join(dir, 'deploy'), { recursive: true });
  writeFileSync(join(dir, '.complete'), '');
}

function buildsOnDisk(): string[] {
  return readdirSync(buildsRootFor(versionsRoot, 'v3')).sort();
}

beforeEach(async () => {
  versionsRoot = mkdtempSync(join(tmpdir(), 'build-prune-'));
  repository = new InMemoryStackVersionRepository();
  repository.seedBundled();
  references = [];
  service = new StackVersionService(
    repository,
    new FakeScriptSpawner(),
    new EventBus(),
    versionsRoot,
    { openReferences: async (id) => references.filter((r) => r.versionId === id && r.resolvedAt === null), pendingShipmentBuildIds: async () => [] },
  );
  const v3 = await repository.insert({ name: 'v3', gitRef: 'main-v3', rootPath: join(versionsRoot, 'v3') });
  versionId = v3.id;
  for (const id of [A, B, C, D, E]) buildOnDisk(id);
  mkdirSync(join(buildsRootFor(versionsRoot, 'v3'), 'tmp-deadbeef00'), { recursive: true });
  mkdirSync(join(buildsRootFor(versionsRoot, 'v3'), 'not-a-build'), { recursive: true });
  mkdirSync(join(versionsRoot, 'v3', 'deploy'), { recursive: true });
  writeFileSync(join(versionsRoot, 'v3', '.env'), 'ENGINE=srs\n');
  await repository.publish(versionId, { buildId: C, commitSha: C, contract: CONTRACT });
  await repository.publish(versionId, { buildId: D, commitSha: D, contract: CONTRACT });
});

describe('pruneBuilds', () => {
  it('keeps the current build, the previous one, every unresolved job reference and every snapshot reference, and deletes the rest', async () => {
    references = [
      reference({ id: 1, holderKind: 'job', buildId: B, services: ['srs', 'stream-uploader'] }),
      reference({ id: 2, holderKind: 'snapshot', buildId: A, holderId: 'stage/srs' }),
    ];

    const outcome = await service.pruneBuilds(versionId);

    assert.deepEqual(outcome, { removed: [E], kept: [A, B, C, D].sort() });
    assert.deepEqual(buildsOnDisk(), [A, B, C, D, 'not-a-build', 'tmp-deadbeef00'].sort());
    assert.ok(existsSync(join(versionsRoot, 'v3', '.env')), 'the flat root is not touched');
  });

  it('deletes a build once its job reference resolved and its snapshot was replaced', async () => {
    references = [
      reference({ id: 1, holderKind: 'job', buildId: B, resolvedAt: at(9) }),
      reference({ id: 2, holderKind: 'snapshot', buildId: A, holderId: 'stage/srs', resolvedAt: at(9) }),
      reference({ id: 3, holderKind: 'snapshot', buildId: D, holderId: 'stage/srs' }),
    ];

    const outcome = await service.pruneBuilds(versionId);

    assert.deepEqual(outcome.removed.sort(), [A, B, E].sort());
    assert.deepEqual(buildsOnDisk(), [C, D, 'not-a-build', 'tmp-deadbeef00'].sort());
  });

  it('protects a build only a snapshot names, whatever the row says', async () => {
    references = [reference({ id: 1, holderKind: 'snapshot', buildId: A, holderId: 'old/srs' })];

    await service.pruneBuilds(versionId);

    assert.ok(existsSync(buildDirFor(versionsRoot, 'v3', A)));
  });

  it('deletes nothing for a legacy row, whose flat root is not a build', async () => {
    repository.markLegacy(versionId);

    const outcome = await service.pruneBuilds(versionId);

    assert.deepEqual(outcome, { removed: [], kept: [] });
    assert.deepEqual(buildsOnDisk(), [A, B, C, D, E, 'not-a-build', 'tmp-deadbeef00'].sort());
  });

  it('runs after a publication, so a build neither current nor previous nor referenced goes then', async () => {
    // Published C, then D: A and B are neither, E too. The publication of D
    // above already ran prune once a service publishes. Assert on a fresh one.
    await repository.publish(versionId, { buildId: A, commitSha: A, contract: CONTRACT });

    await service.pruneBuilds(versionId);

    assert.deepEqual(buildsOnDisk(), [A, D, 'not-a-build', 'tmp-deadbeef00'].sort());
  });
});
