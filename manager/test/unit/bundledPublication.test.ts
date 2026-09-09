/**
 * What boot still does about the bundled version, now that publishing it is a
 * command and no longer something the api does as it starts.
 *
 * Unit test over the in-memory versions table and a scratch versions root.
 * `pnpm test` in manager/.
 *
 * A manager deploy seals the streaming stack into a package on the machine it
 * runs from, ships that package to the host, and the host publishes it from
 * the image the deploy has just built, under a directory that one upgrade
 * holds for its whole run. Boot takes no part in that. What boot still does is
 * refresh the metadata of a row that has never been published, which is the
 * one case where the commit next to the checkout is the only thing that knows
 * what the manager ships with. Once the row has a build, boot leaves it alone,
 * and everything the manager reads out of the bundled stack comes from that
 * build instead of from the tree the engines mount.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import { EventBus } from '../../src/domain/EventBus.js';
import { BUILD_COMPLETE_MARKER } from '../../src/domain/versions/buildManifest.js';
import { readStackContract } from '../../src/domain/versions/stackContract.js';
import { buildDirFor, configRootFor, stackRootOf } from '../../src/domain/versions/stackPaths.js';
import { StackVersionService } from '../../src/domain/versions/StackVersionService.js';
import { BUNDLED_STACK_ROOT } from '../../src/utils/envUtils.js';
import { FakeScriptSpawner } from '../support/FakeScriptSpawner.js';
import { InMemoryStackVersionRepository } from '../support/InMemoryStackVersionRepository.js';
import { V3_FIXTURE } from '../support/stackFixtures.js';

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
/** The base env a checkout ships: every key the sample declares, with a value that tells two apart. */
function baseEnv(token: string): string {
  return (
    readFileSync(join(V3_FIXTURE, '.env.sample'), 'utf8').replace('API_AUTH_TOKEN=', `API_AUTH_TOKEN=${token}`) +
    `SRT_PASSPHRASE=pass-${token}\n`
  );
}

let root: string;
let versionsRoot: string;
let legacyRoot: string;
let repository: InMemoryStackVersionRepository;
let service: StackVersionService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bundled-publication-'));
  versionsRoot = join(root, 'versions');
  mkdirSync(versionsRoot, { recursive: true });
  // The tree the api and the engines mount today, with a file of its own to
  // tell whether anything touched it.
  legacyRoot = join(root, 'manager', 'swarm-hls-stream');
  cpSync(V3_FIXTURE, legacyRoot, { recursive: true });
  writeFileSync(join(legacyRoot, '.env'), baseEnv('legacy'));
  writeFileSync(join(legacyRoot, 'engines', 'srs', 'marker'), 'the engine reads this\n');
  repository = new InMemoryStackVersionRepository();
  repository.seedBundled();
  service = new StackVersionService(
    repository,
    new FakeScriptSpawner(),
    new EventBus(),
    versionsRoot,
    { openReferences: async () => [], pendingShipmentBuildIds: async () => [] },
    legacyRoot,
  );
});

/** A published build of the bundled version, as the upgrade command leaves one. */
async function publishBuild(commit: string, env: string): Promise<string> {
  const build = buildDirFor(versionsRoot, 'bundled', commit);
  cpSync(V3_FIXTURE, build, { recursive: true });
  writeFileSync(join(build, '.env'), env);
  writeFileSync(join(build, BUILD_COMPLETE_MARKER), '');
  writeFileSync(join(build, '.stack-manifest.json'), JSON.stringify({
    buildId: commit, commit, builtAt: '2026-09-09T00:00:00.000Z', toolchain: 'synthetic',
  }));
  const bundled = (await repository.findByName('bundled'))!;
  await repository.publish(bundled.id, {
    buildId: commit, commitSha: commit, rootPath: configRootFor(versionsRoot, 'bundled'), contract: readStackContract(build),
  });
  return build;
}

async function bundled() {
  const row = await repository.findByName('bundled');
  assert.ok(row, 'the bundled row exists');
  return row;
}

function legacyBytes(): string {
  return readFileSync(join(legacyRoot, '.env'), 'utf8') + readFileSync(join(legacyRoot, 'engines', 'srs', 'marker'), 'utf8');
}

describe('what boot does about the bundled version', () => {
  it('leaves a row that was never published legacy on the legacy tree, and takes its commit from the file beside it', async () => {
    const before = legacyBytes();

    await service.syncBundled(legacyRoot, COMMIT_B);

    const row = await bundled();
    assert.equal(row.layout, 'legacy');
    assert.equal(row.rootPath, null);
    assert.equal(row.commitSha, COMMIT_B, 'the commit the deploy wrote next to the tree');
    assert.equal(stackRootOf(row), BUNDLED_STACK_ROOT, 'the tree the manager ships with, wherever this manager has it');
    assert.equal(legacyBytes(), before);
  });

  it('keeps the build a published row has, whatever commit the legacy tree says it is on', async () => {
    await publishBuild(COMMIT_A, baseEnv('one'));

    await service.syncBundled(legacyRoot, COMMIT_B);

    const row = await bundled();
    assert.equal(row.layout, 'builds');
    assert.equal(row.buildId, COMMIT_A);
    assert.equal(row.commitSha, COMMIT_A);
    assert.equal(stackRootOf(row), buildDirFor(versionsRoot, 'bundled', COMMIT_A));
  });

  it('answers the host passphrase from the tree a legacy row runs, and from the build once one is published', async () => {
    assert.equal(await service.hostPassphrase(), 'pass-legacy');

    await publishBuild(COMMIT_A, baseEnv('one'));

    assert.equal(await service.hostPassphrase(), 'pass-one');
  });
});
