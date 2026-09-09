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
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { EventBus } from '../../src/domain/EventBus.js';
import { BUILD_COMPLETE_MARKER, BUILD_MANIFEST_FILE, readBuildManifest } from '../../src/domain/versions/buildManifest.js';
import { readHostConfigRevision } from '../../src/domain/versions/hostConfigCapture.js';
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
    { openReferences: async () => [] },
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
async function buildSucceeds(commit: string, name = 'bundled'): Promise<void> {
  const staging = stagingDirFor(versionsRoot, name, runner.last.args[4]!);
  cpSync(V3_FIXTURE, staging, { recursive: true });
  writeFileSync(join(staging, '.stack-commit'), `${commit}\n`);
  runner.finish(0);
  await until(`the ${name} row to settle`, async () => (await repository.findByName(name))?.status !== 'building');
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

describe("where the bundled version's settings come from", () => {
  /** The base env an older stack left in the tree the engines mount. */
  const LEGACY_ENV = 'STAMP=paid-for\nSTREAM_KEY=the-key\nENGINE=srs\n';

  beforeEach(() => {
    pinned(PIN);
    writeFileSync(join(legacyRoot, '.env'), LEGACY_ENV);
    writeFileSync(join(legacyRoot, 'deploy', 'config.json'), '{"slots":3}\n');
  });

  async function buildBundled(): Promise<string> {
    await service.ensureBundledBuild();
    await buildSucceeds(PIN);
    return configRootFor(versionsRoot, 'bundled');
  }

  it('takes them from the legacy tree the first time, byte for byte', async () => {
    const configRoot = await buildBundled();

    assert.ok(readFileSync(join(configRoot, '.env'), 'utf8').startsWith(LEGACY_ENV), 'the operator lines, unchanged and first');
    assert.equal(readFileSync(join(configRoot, 'deploy', 'config.json'), 'utf8'), '{"slots":3}\n');
  });

  it('completes them from the sample of the version being built, and captures that revision', async () => {
    const configRoot = await buildBundled();

    const env = readFileSync(join(configRoot, '.env'), 'utf8');
    assert.match(env, /\nAPI_AUTH_TOKEN=\n/, 'a key the sample declares and the legacy tree never had');
    assert.match(env, /\nCHEQUEBOOK_MIN_BZZ=0\.5\n/, 'with the sample value where it has one');
    const revision = await readHostConfigRevision(configRoot);
    assert.equal(revision?.generation, 2, 'one revision for the carry over, one for the completion');
    assert.equal(readBuildManifest(buildDirFor(versionsRoot, 'bundled', PIN)).manifest?.inputGeneration, 2);
  });

  it('carries an engine env over as well, and completes it from the engine sample', async () => {
    writeFileSync(join(legacyRoot, 'engines', 'srs', '.env'), 'SRS_API_PORT=1985\n');

    const configRoot = await buildBundled();

    const engineEnv = readFileSync(join(configRoot, 'engines', 'srs', '.env'), 'utf8');
    assert.ok(engineEnv.startsWith('SRS_API_PORT=1985\n'), 'the operator line, unchanged and first');
    assert.match(engineEnv, /\nSRT_PASSPHRASE=\n/, 'a key the engine sample declares and the legacy tree never had');
  });

  it('never writes to the legacy tree, which the running engines still mount', async () => {
    const before = legacyBytes();

    await buildBundled();

    assert.equal(legacyBytes(), before);
    assert.equal(readFileSync(join(legacyRoot, '.env'), 'utf8'), LEGACY_ENV);
    assert.equal(existsSync(join(legacyRoot, '.config-revision.json')), false);
  });

  it('takes them from the legacy tree once, and leaves later builds with what the host has', async () => {
    const configRoot = await buildBundled();
    writeFileSync(join(legacyRoot, '.env'), 'STAMP=someone-edited-the-old-tree\n');

    await service.update((await bundled()).id);
    await buildSucceeds(PIN);

    assert.ok(readFileSync(join(configRoot, '.env'), 'utf8').startsWith(LEGACY_ENV), 'the settings the host already had');
  });

  describe('the modes those files keep', () => {
    let umask: number;
    before(() => { umask = process.umask(0o022); });
    after(() => { process.umask(umask); });

    it('carries the mode of the legacy file over, and the completion keeps it', async () => {
      chmodSync(join(legacyRoot, '.env'), 0o600);

      const configRoot = await buildBundled();

      assert.equal(statSync(join(configRoot, '.env')).mode & 0o777, 0o600, 'only the owner reads the passphrase and the stream key');
    });
  });

  it('never reads the legacy tree for a version an operator added', async () => {
    await service.add('review-stack', 'main-v3');
    await buildSucceeds(COMMIT_A, 'review-stack');

    const env = readFileSync(join(configRootFor(versionsRoot, 'review-stack'), '.env'), 'utf8');
    assert.equal(env, readFileSync(join(V3_FIXTURE, '.env.sample'), 'utf8'), 'seeded from the sample the version ships');
    assert.equal(env.includes('paid-for'), false, 'and never from the tree the bundled version came with');
  });
});
