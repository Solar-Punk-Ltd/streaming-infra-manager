/**
 * The manager's own deploy publishes the bundled stack as a build of its
 * own, and the legacy tree it used to overwrite is left as it is.
 *
 * Unit test over the in-memory versions table and a scratch versions root.
 * `pnpm test` in manager/.
 *
 * The deploy used to rsync the bundled stack over the tree the api and the
 * engines mount, so a container restart after a manager deploy ran an old
 * container on replacement files. Now the deploy ships the built stack into
 * `bundled.incoming/` under the versions root, and the api publishes it at
 * boot into `bundled.builds/<commit>/` the way an added version's build is
 * published: manifest and marker, one row update, the previous build kept,
 * the same commit with the same inputs adopted. The legacy tree is never
 * written to again. A row that was never published stays legacy on it.
 */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import { EventBus } from '../../src/domain/EventBus.js';
import { BUILD_COMPLETE_MARKER, readBuildManifest } from '../../src/domain/versions/buildManifest.js';
import { readHostConfigRevision } from '../../src/domain/versions/hostConfigCapture.js';
import {
  buildDirFor,
  buildsRootFor,
  bundledIncomingRootFor,
  configRootFor,
  stackRootOf,
} from '../../src/domain/versions/stackPaths.js';
import { STACK_COMMIT_FILE, StackVersionService } from '../../src/domain/versions/StackVersionService.js';
import { FakeScriptSpawner } from '../support/FakeScriptSpawner.js';
import { InMemoryStackVersionRepository } from '../support/InMemoryStackVersionRepository.js';
import { V3_FIXTURE } from '../support/stackFixtures.js';

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const ENV_ONE = 'API_AUTH_TOKEN=one\nSRS_WEBHOOK_TOKEN=one\n';
const ENV_TWO = 'API_AUTH_TOKEN=two\nSRS_WEBHOOK_TOKEN=two\n';

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
  writeFileSync(join(legacyRoot, '.env'), 'API_AUTH_TOKEN=legacy\nSRS_WEBHOOK_TOKEN=legacy\n');
  writeFileSync(join(legacyRoot, 'engines', 'srs', 'marker'), 'the engine reads this\n');
  repository = new InMemoryStackVersionRepository();
  repository.seedBundled();
  service = new StackVersionService(repository, new FakeScriptSpawner(), new EventBus(), versionsRoot, {
    openReferences: async () => [],
  });
});

/** What the deploy ships: the built stack, its commit, and the base env of the checkout it came from. */
function shipped(commit: string, env = ENV_ONE): string {
  const incoming = bundledIncomingRootFor(versionsRoot);
  cpSync(V3_FIXTURE, incoming, { recursive: true });
  writeFileSync(join(incoming, STACK_COMMIT_FILE), `${commit}\n`);
  writeFileSync(join(incoming, '.env'), env);
  return incoming;
}

async function bundled() {
  const row = await repository.findByName('bundled');
  assert.ok(row, 'the bundled row exists');
  return row;
}

function legacyBytes(): string {
  return readFileSync(join(legacyRoot, '.env'), 'utf8') + readFileSync(join(legacyRoot, 'engines', 'srs', 'marker'), 'utf8');
}

describe('publishing the shipped bundled stack', () => {
  it('publishes it as a build of the bundled version, which deploys from it, and leaves the legacy tree alone', async () => {
    const before = legacyBytes();
    shipped(COMMIT_A);

    await service.syncBundled(legacyRoot, 'c'.repeat(40));

    const row = await bundled();
    assert.equal(row.layout, 'builds');
    assert.equal(row.buildId, COMMIT_A);
    assert.equal(row.commitSha, COMMIT_A);
    assert.equal(row.rootPath, configRootFor(versionsRoot, 'bundled'));
    assert.ok(row.contract, 'the contract is read from the build');
    const build = buildDirFor(versionsRoot, 'bundled', COMMIT_A);
    assert.equal(stackRootOf(row), build);
    assert.equal(readBuildManifest(build).manifest?.commit, COMMIT_A);
    assert.ok(existsSync(join(build, BUILD_COMPLETE_MARKER)));
    assert.equal(readFileSync(join(build, '.env'), 'utf8'), ENV_ONE, 'the shipped base env is the build\'s');
    assert.equal(existsSync(bundledIncomingRootFor(versionsRoot)), false, 'the shipment became the build');
    assert.equal(legacyBytes(), before, 'nothing wrote into the legacy tree');
  });

  it('commits the shipped base env as the bundled version\'s host configuration, generation one', async () => {
    shipped(COMMIT_A);

    await service.syncBundled(legacyRoot, null);

    const configRoot = configRootFor(versionsRoot, 'bundled');
    assert.equal(readFileSync(join(configRoot, '.env'), 'utf8'), ENV_ONE);
    assert.equal((await readHostConfigRevision(configRoot))?.generation, 1);
  });

  it('leaves a row that was never published legacy on the legacy tree when nothing was shipped', async () => {
    const before = legacyBytes();

    await service.syncBundled(legacyRoot, COMMIT_B);

    const row = await bundled();
    assert.equal(row.layout, 'legacy');
    assert.equal(row.rootPath, null);
    assert.equal(row.commitSha, COMMIT_B, 'the commit the deploy wrote next to the tree');
    assert.equal(stackRootOf(row), legacyRoot);
    assert.equal(legacyBytes(), before);
  });

  it('keeps the build it has when nothing was shipped, whatever the legacy tree says', async () => {
    shipped(COMMIT_A);
    await service.syncBundled(legacyRoot, null);

    await service.syncBundled(legacyRoot, COMMIT_B);

    const row = await bundled();
    assert.equal(row.buildId, COMMIT_A);
    assert.equal(row.commitSha, COMMIT_A);
    assert.equal(stackRootOf(row), buildDirFor(versionsRoot, 'bundled', COMMIT_A));
  });

  it('adopts the build it already has for the same commit and inputs, and drops the shipment', async () => {
    shipped(COMMIT_A);
    await service.syncBundled(legacyRoot, null);
    const manifestBefore = readFileSync(join(buildDirFor(versionsRoot, 'bundled', COMMIT_A), '.stack-manifest.json'), 'utf8');

    shipped(COMMIT_A);
    await service.syncBundled(legacyRoot, null);

    const row = await bundled();
    assert.equal(row.buildId, COMMIT_A);
    assert.equal(row.previousBuildId, null);
    assert.deepEqual(readdirSync(buildsRootFor(versionsRoot, 'bundled')), [COMMIT_A]);
    assert.equal(readFileSync(join(buildDirFor(versionsRoot, 'bundled', COMMIT_A), '.stack-manifest.json'), 'utf8'), manifestBefore, 'the build was not touched');
    assert.equal(existsSync(bundledIncomingRootFor(versionsRoot)), false);
  });

  it('gives the same commit shipped with another base env a distinct identity, keeping the previous build as it was', async () => {
    shipped(COMMIT_A, ENV_ONE);
    await service.syncBundled(legacyRoot, null);

    shipped(COMMIT_A, ENV_TWO);
    await service.syncBundled(legacyRoot, null);

    const row = await bundled();
    assert.equal(row.buildId, `${COMMIT_A}-r1`);
    assert.equal(row.previousBuildId, COMMIT_A);
    assert.equal((await readHostConfigRevision(configRootFor(versionsRoot, 'bundled')))?.generation, 2);
    assert.equal(readFileSync(join(buildDirFor(versionsRoot, 'bundled', `${COMMIT_A}-r1`), '.env'), 'utf8'), ENV_TWO);
    assert.equal(readFileSync(join(buildDirFor(versionsRoot, 'bundled', COMMIT_A), '.env'), 'utf8'), ENV_ONE, 'files under a published path are never replaced');
  });

  it('publishes a new commit beside the previous build', async () => {
    shipped(COMMIT_A);
    await service.syncBundled(legacyRoot, null);

    shipped(COMMIT_B);
    await service.syncBundled(legacyRoot, null);

    const row = await bundled();
    assert.equal(row.buildId, COMMIT_B);
    assert.equal(row.previousBuildId, COMMIT_A);
    assert.deepEqual(readdirSync(buildsRootFor(versionsRoot, 'bundled')).sort(), [COMMIT_A, COMMIT_B]);
  });

  it('keeps the row as it was and says why when the shipment cannot be published', async () => {
    const incoming = shipped(COMMIT_A);
    await service.syncBundled(legacyRoot, null);
    const broken = shipped(COMMIT_B);
    writeFileSync(join(broken, STACK_COMMIT_FILE), 'not a commit\n');

    await service.syncBundled(legacyRoot, null);

    const row = await bundled();
    assert.equal(row.buildId, COMMIT_A);
    assert.equal(row.status, 'ready');
    assert.match(row.lastError ?? '', new RegExp(STACK_COMMIT_FILE.replace('.', '\\.')));
    assert.ok(existsSync(incoming), 'the shipment is left for a look, the next deploy replaces it');
  });
});
