/**
 * What boot does about the bundled version: it builds the stack commit the
 * manager pins, on the host, through the same path an added version takes.
 *
 * Unit test over the in-memory versions table and a scratch versions root.
 * Nothing here reaches git, Docker or the network: the build script is stood
 * in for, and the test puts what it would leave in the staging directory.
 * `pnpm test` in manager/.
 *
 * A manager deploy writes the commit its submodule pin records into
 * `manager/.stack-commit` beside the checkout, and ships nothing else of the
 * streaming stack. At boot the api reads that pin, and if the bundled row is
 * not already on a complete build of it, it builds it: the same build script,
 * the same mutex, the same log. A machine without that file is a developer
 * laptop, and there the row stays legacy on the tree the manager ships with.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import { EventBus } from '../../src/domain/EventBus.js';
import { BUILD_COMPLETE_MARKER, BUILD_MANIFEST_FILE } from '../../src/domain/versions/buildManifest.js';
import { readStackContract } from '../../src/domain/versions/stackContract.js';
import {
  buildDirFor,
  configRootFor,
  repoRootFor,
  stackRootOf,
  stagingDirFor,
} from '../../src/domain/versions/stackPaths.js';
import {
  BUILD_SCRIPT,
  STACK_REPO_URL,
  StackVersionService,
} from '../../src/domain/versions/StackVersionService.js';
import { BUNDLED_STACK_ROOT } from '../../src/utils/envUtils.js';
import { FakeScriptSpawner } from '../support/FakeScriptSpawner.js';
import { InMemoryStackVersionRepository } from '../support/InMemoryStackVersionRepository.js';
import { V3_FIXTURE } from '../support/stackFixtures.js';

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const PIN = 'c'.repeat(40);

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
let runner: FakeScriptSpawner;
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
  runner = new FakeScriptSpawner();
  service = new StackVersionService(
    repository,
    runner,
    new EventBus(),
    versionsRoot,
    { openReferences: async () => [], pendingShipmentBuildIds: async () => [] },
    legacyRoot,
  );
});

/** The commit the deploy pinned, written where it writes it. */
function pinned(commit: string): void {
  writeFileSync(join(dirname(legacyRoot), '.stack-commit'), `${commit}\n`);
}

/** A published build of the bundled version, as a finished build leaves one. */
async function publishBuild(commit: string, env: string): Promise<string> {
  const build = buildDirFor(versionsRoot, 'bundled', commit);
  cpSync(V3_FIXTURE, build, { recursive: true });
  writeFileSync(join(build, '.env'), env);
  writeFileSync(join(build, BUILD_COMPLETE_MARKER), '');
  writeFileSync(join(build, BUILD_MANIFEST_FILE), JSON.stringify({
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

const settle = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, condition: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await settle();
  }
}

/** What the build script leaves behind when it succeeds, then the run ending. */
async function buildSucceeds(commit: string): Promise<void> {
  const staging = stagingDirFor(versionsRoot, 'bundled', runner.last.args[4]!);
  cpSync(V3_FIXTURE, staging, { recursive: true });
  writeFileSync(join(staging, '.stack-commit'), `${commit}\n`);
  runner.finish(0);
  await until('the bundled row to settle', async () => (await bundled()).status !== 'building');
}

describe('what boot does about the pinned stack commit', () => {
  it('builds it when the bundled version has no build of it, with the commit as the ref', async () => {
    pinned(PIN);

    const build = await service.ensureBundledBuild();

    assert.ok(build, 'boot started a build');
    assert.equal(runner.spawned.length, 1);
    assert.equal(runner.last.script, BUILD_SCRIPT);
    assert.deepEqual(runner.last.args.slice(0, 4), [
      repoRootFor(versionsRoot, 'bundled'),
      stagingDirFor(versionsRoot, 'bundled', runner.last.args[4]!),
      PIN,
      STACK_REPO_URL,
    ]);
    assert.equal((await bundled()).gitRef, PIN, 'the row follows the pinned commit from now on');
    assert.equal((await bundled()).status, 'building');
  });

  it('leaves the row on a build of that commit once the build finished', async () => {
    pinned(PIN);
    await service.ensureBundledBuild();

    await buildSucceeds(PIN);

    const row = await bundled();
    assert.equal(row.layout, 'builds');
    assert.equal(row.commitSha, PIN);
    assert.equal(row.buildId, PIN);
    assert.equal(row.gitRef, PIN);
    assert.equal(stackRootOf(row), buildDirFor(versionsRoot, 'bundled', PIN));
  });

  it('starts nothing when the row already deploys from a complete build of the pin', async () => {
    pinned(PIN);
    await publishBuild(PIN, baseEnv('pinned'));

    assert.equal(await service.ensureBundledBuild(), null);
    assert.equal(runner.spawned.length, 0);
  });

  it('builds again when the row is on a build of another commit', async () => {
    pinned(PIN);
    await publishBuild(COMMIT_A, baseEnv('older'));

    assert.ok(await service.ensureBundledBuild());
    assert.equal(runner.last.args[2], PIN);
  });

  it('tries again after a build that failed, which is what makes a lost network heal on a restart', async () => {
    pinned(PIN);
    await service.ensureBundledBuild();
    runner.finish(1, 'could not reach github');
    await until('the failure to be recorded', async () => (await bundled()).status !== 'building');
    assert.equal((await bundled()).status, 'failed');

    assert.ok(await service.ensureBundledBuild(), 'the next boot builds it again');
    assert.equal(runner.spawned.length, 2);
  });

  it('starts nothing while another version is building, and says so', async () => {
    pinned(PIN);
    await service.add('review-stack', 'main-v3');

    assert.equal(await service.ensureBundledBuild(), null);
    assert.equal(runner.spawned.length, 1, 'only the version that was already building');
  });

  it('leaves a manager that pins no commit on the legacy tree, untouched', async () => {
    const before = legacyBytes();

    assert.equal(await service.ensureBundledBuild(), null);

    const row = await bundled();
    assert.equal(row.layout, 'legacy');
    assert.equal(row.rootPath, null);
    assert.equal(runner.spawned.length, 0);
    assert.equal(legacyBytes(), before);
  });
});

describe('what boot does about the legacy bundled metadata', () => {
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
