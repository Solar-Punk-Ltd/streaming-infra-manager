/**
 * How a build becomes the version's current build: one immutable directory,
 * published by one row update, with the previous build kept for recovery.
 *
 * Unit test, no database, no Docker and no network. `pnpm test` in manager/.
 * The build script is stood in for: the test puts what the script would
 * leave in the attempt's staging directory, a built tree and the commit it
 * was exported from, and finishes the fake run.
 *
 * Before this, the build script moved the checkout to the new commit, built
 * in place and copied over the root, so a failed update left a mixed tree, a
 * deploy admitted during the update ran on it, and a container restart picked
 * up new files under an old container.
 */
import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import { EventBus } from '../../src/domain/EventBus.js';
import {
  BUILD_COMPLETE_MARKER,
  BUILD_MANIFEST_FILE,
  readBuildManifest,
} from '../../src/domain/versions/buildManifest.js';
import {
  commitHostConfig,
  CONFIG_REVISION_FILE,
} from '../../src/domain/versions/hostConfigCapture.js';
import {
  buildDirFor,
  buildsRootFor,
  configRootFor,
  deployRootProblem,
  repoRootFor,
  stackRootOf,
  stagingDirFor,
} from '../../src/domain/versions/stackPaths.js';
import {
  BUILD_SCRIPT,
  STACK_REPO_URL,
  StackVersionService,
} from '../../src/domain/versions/StackVersionService.js';
import { FakeScriptSpawner } from '../support/FakeScriptSpawner.js';
import { InMemoryStackVersionRepository } from '../support/InMemoryStackVersionRepository.js';
import { scratchVersionsRoot, V3_FIXTURE } from '../support/stackFixtures.js';

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);

let repository: InMemoryStackVersionRepository;
let runner: FakeScriptSpawner;
let service: StackVersionService;
let versionsRoot: string;

beforeEach(() => {
  versionsRoot = scratchVersionsRoot();
  repository = new InMemoryStackVersionRepository();
  repository.seedBundled();
  runner = new FakeScriptSpawner();
  service = new StackVersionService(repository, runner, new EventBus(), versionsRoot, { openReferences: async () => [] });
});

const settle = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, condition: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await settle();
  }
}

/** The attempt id the service handed the script, from the script's arguments. */
function attemptOf(): string {
  const attempt = runner.last.args[4];
  assert.ok(attempt && /^[0-9a-f]{8,}$/.test(attempt), `an attempt id, got ${attempt}`);
  return attempt;
}

/** What the script leaves in the attempt's staging directory when it succeeds. */
function builtInStaging(name: string, commit: string): string {
  const staging = stagingDirFor(versionsRoot, name, attemptOf());
  cpSync(V3_FIXTURE, staging, { recursive: true });
  writeFileSync(join(staging, '.stack-commit'), `${commit}\n`);
  return staging;
}

async function rowNamed(name: string) {
  const row = await repository.findByName(name);
  assert.ok(row, `${name} exists`);
  return row;
}

async function finished(name: string, code = 0, log = ''): Promise<void> {
  const before = (await rowNamed(name)).builtAt?.getTime() ?? 0;
  runner.finish(code, log);
  await until(`${name} to settle`, async () => {
    const row = await rowNamed(name);
    return row.status !== 'building' && (code !== 0 || (row.builtAt?.getTime() ?? 0) > before || row.lastError !== null);
  });
}

async function addBuilt(name: string, commit: string): Promise<number> {
  await service.add(name, 'main-v3');
  builtInStaging(name, commit);
  await finished(name);
  return (await rowNamed(name)).id;
}

describe('adding a version', () => {
  it('runs the build script with the clone, the staging directory of this attempt, the ref, the repository and the attempt', async () => {
    await service.add('v3', 'main-v3');

    const attempt = attemptOf();
    assert.equal(runner.last.script, BUILD_SCRIPT);
    assert.deepEqual(runner.last.args, [
      repoRootFor(versionsRoot, 'v3'),
      stagingDirFor(versionsRoot, 'v3', attempt),
      'main-v3',
      STACK_REPO_URL,
      attempt,
    ]);
  });

  it('publishes the build as one immutable directory, and the row as one update', async () => {
    await addBuilt('v3', COMMIT_A);

    const row = await rowNamed('v3');
    assert.equal(row.status, 'ready');
    assert.equal(row.layout, 'builds');
    assert.equal(row.buildId, COMMIT_A);
    assert.equal(row.commitSha, COMMIT_A);
    assert.equal(row.previousBuildId, null);
    assert.ok(row.contract && row.contract.maxSlot > 0, 'the contract was read from the build');

    const build = buildDirFor(versionsRoot, 'v3', COMMIT_A);
    assert.ok(existsSync(join(build, BUILD_COMPLETE_MARKER)));
    const manifest = readBuildManifest(build);
    assert.equal(manifest.manifest?.commit, COMMIT_A);
    assert.equal(manifest.manifest?.buildId, COMMIT_A);
    assert.equal(existsSync(stagingDirFor(versionsRoot, 'v3', attemptOf())), false, 'the staging directory is gone');
    assert.equal(stackRootOf(row), build);
  });

  it('seeds the host configuration from the samples as generation one, and copies it into the build', async () => {
    await addBuilt('v3', COMMIT_A);

    const configRoot = configRootFor(versionsRoot, 'v3');
    assert.ok(existsSync(join(configRoot, '.env')), 'the base env was seeded from .env.sample');
    const revision = JSON.parse(readFileSync(join(configRoot, CONFIG_REVISION_FILE), 'utf8'));
    assert.equal(revision.generation, 1);
    const build = buildDirFor(versionsRoot, 'v3', COMMIT_A);
    assert.equal(readFileSync(join(build, '.env'), 'utf8'), readFileSync(join(configRoot, '.env'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(build, BUILD_MANIFEST_FILE), 'utf8'));
    assert.equal(manifest.inputGeneration, 1);
  });
});

describe('updating a version', () => {
  it('reuses a complete build of the same commit and inputs rather than replacing files under it', async () => {
    const id = await addBuilt('v3', COMMIT_A);
    const build = buildDirFor(versionsRoot, 'v3', COMMIT_A);
    const builtAt = readBuildManifest(build).manifest?.builtAt;

    await service.update(id);
    builtInStaging('v3', COMMIT_A);
    await finished('v3');

    const row = await rowNamed('v3');
    assert.equal(row.buildId, COMMIT_A);
    assert.equal(row.previousBuildId, null);
    assert.equal(readBuildManifest(build).manifest?.builtAt, builtAt, 'the published build was not touched');
    assert.deepEqual(readdirSync(buildsRootFor(versionsRoot, 'v3')), [COMMIT_A], 'no staging directory left');
  });

  it('gives the same commit with new host inputs a distinct identity, and keeps the previous build', async () => {
    const id = await addBuilt('v3', COMMIT_A);
    const configRoot = configRootFor(versionsRoot, 'v3');
    await commitHostConfig(configRoot, { '.env': Buffer.from(`${readFileSync(join(configRoot, '.env'), 'utf8')}CHEQUEBOOK_MIN_BZZ=1\n`) });
    await service.setTested(id, true, COMMIT_A);

    await service.update(id);
    builtInStaging('v3', COMMIT_A);
    await finished('v3');

    const row = await rowNamed('v3');
    assert.equal(row.buildId, `${COMMIT_A}-r1`);
    assert.equal(row.previousBuildId, COMMIT_A);
    assert.equal(row.commitSha, COMMIT_A);
    assert.equal(row.tested, false, 'approval keys on the build id');
    const rebuilt = buildDirFor(versionsRoot, 'v3', `${COMMIT_A}-r1`);
    assert.match(readFileSync(join(rebuilt, '.env'), 'utf8'), /CHEQUEBOOK_MIN_BZZ=1/);
    assert.equal(readBuildManifest(rebuilt).manifest?.buildId, `${COMMIT_A}-r1`);
    assert.ok(existsSync(join(buildDirFor(versionsRoot, 'v3', COMMIT_A), BUILD_COMPLETE_MARKER)), 'the previous build stays');
  });

  it('publishes a new commit beside the previous build', async () => {
    const id = await addBuilt('v3', COMMIT_A);

    await service.update(id);
    builtInStaging('v3', COMMIT_B);
    await finished('v3');

    const row = await rowNamed('v3');
    assert.equal(row.buildId, COMMIT_B);
    assert.equal(row.previousBuildId, COMMIT_A);
    assert.equal(row.commitSha, COMMIT_B);
    assert.deepEqual(readdirSync(buildsRootFor(versionsRoot, 'v3')).sort(), [COMMIT_A, COMMIT_B]);
  });

  it('leaves the row ready at the old build with the reason when the build fails', async () => {
    const id = await addBuilt('v3', COMMIT_A);

    await service.update(id);
    const staging = stagingDirFor(versionsRoot, 'v3', attemptOf());
    mkdirSync(staging, { recursive: true });
    await finished('v3', 1, 'pnpm install failed\n');

    const row = await rowNamed('v3');
    assert.equal(row.status, 'ready');
    assert.equal(row.buildId, COMMIT_A);
    assert.match(row.lastError ?? '', /pnpm install failed/);
    assert.equal(existsSync(staging), false, 'the staging directory is gone');
  });

  it('records the failure even when the staging directory cannot be removed, and leaves it for a hand', async () => {
    const id = await addBuilt('v3', COMMIT_A);

    await service.update(id);
    const staging = stagingDirFor(versionsRoot, 'v3', attemptOf());
    mkdirSync(staging, { recursive: true });
    // A builds root nobody may write to: the staging directory cannot be
    // unlinked from it, the way a tree the build container left owned by
    // root cannot be removed by the manager's own user.
    const buildsRoot = buildsRootFor(versionsRoot, 'v3');
    chmodSync(buildsRoot, 0o555);
    try {
      await finished('v3', 1, 'pnpm install failed\n');
    } finally {
      chmodSync(buildsRoot, 0o755);
    }

    const row = await rowNamed('v3');
    assert.equal(row.status, 'ready');
    assert.equal(row.buildId, COMMIT_A);
    assert.match(row.lastError ?? '', /pnpm install failed/);
    // Root removes anything, so only a plain user sees the directory stay.
    if (process.getuid?.() !== 0) {
      assert.equal(existsSync(staging), true, 'the staging directory is left where it could not be removed');
    }
  });

  it('treats a build that left no commit behind as failed, naming what is missing', async () => {
    const id = await addBuilt('v3', COMMIT_A);

    await service.update(id);
    const staging = stagingDirFor(versionsRoot, 'v3', attemptOf());
    cpSync(V3_FIXTURE, staging, { recursive: true });
    await finished('v3', 0);

    const row = await rowNamed('v3');
    assert.equal(row.status, 'ready');
    assert.equal(row.buildId, COMMIT_A);
    assert.match(row.lastError ?? '', /\.stack-commit/);
  });

  it('marks a version with no usable build failed', async () => {
    await service.add('v3', 'main-v3');
    await finished('v3', 1, 'clone failed\n');

    const row = await rowNamed('v3');
    assert.equal(row.status, 'failed');
    assert.equal(row.buildId, null);
    assert.match(row.lastError ?? '', /clone failed/);
  });
});

describe('what boot does with the attempts a gone manager left', () => {
  it('removes a staging directory whose builder is gone and keeps one whose builder still runs', async () => {
    const builds = buildsRootFor(versionsRoot, 'v3');
    mkdirSync(join(builds, 'tmp-dead0000'), { recursive: true });
    mkdirSync(join(builds, 'tmp-live0000'), { recursive: true });
    await addBuilt('v3', COMMIT_A);

    const outcome = await service.cleanInterruptedAttempts({
      containerExists: async (name) => name === 'stack-build-live0000',
    });

    assert.deepEqual(outcome, { removed: ['v3/tmp-dead0000'], kept: ['v3/tmp-live0000'] });
    assert.equal(existsSync(join(builds, 'tmp-dead0000')), false);
    assert.ok(existsSync(join(builds, 'tmp-live0000')));
  });
});

describe('where a version deploys from', () => {
  it('is the current build for a builds row, and the flat root for a legacy one', async () => {
    await addBuilt('v3', COMMIT_A);
    const row = await rowNamed('v3');

    assert.equal(stackRootOf(row), buildDirFor(versionsRoot, 'v3', COMMIT_A));
    assert.equal(deployRootProblem(row), null);
    assert.equal(stackRootOf({ ...row, layout: 'legacy', buildId: null }), join(versionsRoot, 'v3'));
    assert.equal(deployRootProblem({ ...row, layout: 'legacy', buildId: null }), null);
  });

  it('refuses a builds row whose build is missing or incomplete, naming it, and never falls back to the flat root', async () => {
    await addBuilt('v3', COMMIT_A);
    const row = await rowNamed('v3');

    const missing = { ...row, buildId: COMMIT_B };
    assert.match(deployRootProblem(missing) ?? '', new RegExp(COMMIT_B));
    assert.match(deployRootProblem({ ...row, buildId: null }) ?? '', /no build/);
  });
});
