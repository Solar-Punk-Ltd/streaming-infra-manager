/**
 * The command the manager deploy runs on the host, from the image it has just
 * built: what it refuses before it takes ownership of anything, what it prints
 * when it worked, and what it tells a person when an earlier upgrade is still
 * holding the host.
 *
 * Unit test with the host operations replaced, so no Docker daemon and no
 * database are touched. `pnpm test` in manager/.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { DEFAULT_BUNDLED_BUILD_MS, type ComposeUpgradeSettings } from '../../../src/cli/ComposeUpgradeOperations.js';
import { processStreams } from '../../../src/cli/commandStreams.js';
import { MANAGER_UPGRADE_USAGE, runManagerUpgradeCommand } from '../../../src/cli/managerUpgrade.js';
import { Logger } from '../../../src/domain/Logger.js';
import { MANAGER_POSTGRES_VOLUME } from '../../../src/domain/versions/managerProject.js';
import type { BundledBuildOutcome, ManagerUpgradeOperations } from '../../../src/domain/versions/ManagerUpgrade.js';
import { managerUpgradeGuardRootFor } from '../../../src/domain/versions/stackPaths.js';
import { BUNDLED_STACK_ROOT } from '../../../src/utils/envUtils.js';
import { config } from '../../../src/utils/config.js';

const MANAGER_COMMIT = 'b'.repeat(40);
const MANAGER_DIGEST = 'e'.repeat(64);
const IMAGE_ID = `sha256:${'f'.repeat(64)}`;
const PIN = 'a'.repeat(40);
const BUNDLED_TIMEOUT = '900';
const HELD_PHASE = 'migrating';

interface CommandRun {
  stdout: string[];
  stderr: string[];
  error: Error | null;
}

describe('manager:upgrade', () => {
  let root: string; let versionsRoot: string; let mutableRoot: string;
  let opened: number; let closed: number;
  let settings: ComposeUpgradeSettings | null;
  let bundled: BundledBuildOutcome;
  let factoryFailure: Error | null; let overrides: Partial<ManagerUpgradeOperations>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 't04b-upgrade-command-'));
    versionsRoot = join(root, 'versions'); mutableRoot = join(root, 'manager');
    await mkdir(versionsRoot); await mkdir(mutableRoot);
    opened = 0; closed = 0; settings = null;
    bundled = { state: 'ready', commit: PIN, buildId: PIN, problem: null };
    factoryFailure = null; overrides = {};
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  function operations(): ManagerUpgradeOperations {
    return {
      readPublication: async () => ({ schema: 'current' }),
      stopApi: async () => {},
      migrate: async () => {},
      startProject: async () => {},
      verifyProject: async () => {},
      awaitBundledBuild: async () => bundled,
    };
  }

  function argvWith(overrides: Record<string, string> = {}, switches: readonly string[] = []): string[] {
    const flags: Record<string, string> = {
      '--manager-commit': MANAGER_COMMIT, '--manager-digest': MANAGER_DIGEST, '--image-id': IMAGE_ID,
      '--project': 'manager', '--compose-file': join(mutableRoot, 'docker-compose.yml'),
      '--mutable-root': mutableRoot, '--bundled-timeout': BUNDLED_TIMEOUT, ...overrides,
    };
    return [...Object.entries(flags).flat(), ...switches];
  }

  async function upgrade(argv: string[]): Promise<CommandRun> {
    const stdout: string[] = []; const stderr: string[] = []; let error: Error | null = null;
    try {
      await runManagerUpgradeCommand(argv, { out: (line) => stdout.push(line), err: (line) => stderr.push(line) }, {
        versionsRoot,
        operations: (given) => {
          opened += 1; settings = given;
          if (factoryFailure) throw factoryFailure;
          return { operations: { ...operations(), ...overrides }, close: async () => { closed += 1; } };
        },
      });
    } catch (thrown) {
      error = thrown as Error;
    }
    return { stdout, stderr, error };
  }

  it('prints one line naming the state and the bundled build it waited for', async () => {
    const run = await upgrade(argvWith());

    assert.equal(run.error, null);
    assert.equal(run.stdout.length, 1);
    assert.deepEqual(JSON.parse(run.stdout[0]!), {
      state: 'completed',
      bundled: { state: 'ready', commit: PIN, buildId: PIN, problem: null },
    });
    assert.deepEqual(run.stderr, []);
    assert.equal(closed, 1, 'what the upgrade opened is let go of again');
  });

  for (const [flag, value] of [
    ['--manager-commit', 'zzzz'],
    ['--manager-digest', 'too-short'],
    ['--image-id', 'sha256:not-a-digest'],
    ['--project', 'Not A Project'],
  ] as const) {
    it(`refuses ${flag} that is not an identity, before it owns anything`, async () => {
      const run = await upgrade(argvWith({ [flag]: value }));

      assert.match(run.error?.message ?? '', /identity|fields/i);
      assert.equal(existsSync(managerUpgradeGuardRootFor(versionsRoot)), false, 'no guard directory was left behind');
      assert.equal(opened, 0, 'nothing on the host was opened');
      assert.deepEqual(run.stdout, []);
    });
  }

  for (const [shape, value] of [
    ['a word', 'soon'],
    ['nothing at all', '0'],
    ['longer than a day', '90000'],
    ['a fraction', '12.5'],
  ] as const) {
    it(`refuses a bundled timeout of ${shape}, and says what the command takes`, async () => {
      const run = await upgrade(argvWith({ '--bundled-timeout': value }));

      assert.match(run.error?.message ?? '', /--bundled-timeout/);
      assert.equal(opened, 0, 'nothing on the host was opened');
    });
  }

  it('waits the default when the deploy names no bundled timeout', async () => {
    const named = argvWith().indexOf('--bundled-timeout');
    const argv = argvWith();
    argv.splice(named, 2);

    const run = await upgrade(argv);

    assert.equal(run.error, null);
    assert.equal(settings?.timeouts?.bundledBuild, DEFAULT_BUNDLED_BUILD_MS);
  });

  it('takes no shipment, because the host builds the stack itself', async () => {
    const run = await upgrade([...argvWith(), '--shipment-id', '3f1c2b64-5a2e-4d7b-8c19-6a0f4d2e8b71']);

    assert.match(run.error?.message ?? '', /--shipment-id/);
    assert.ok((run.error?.message ?? '').includes(MANAGER_UPGRADE_USAGE), 'the usage of this command comes with the refusal');
    assert.equal(opened, 0);
  });

  it('refuses an option it does not take rather than guessing at it, and says what it does take', async () => {
    const run = await upgrade([...argvWith(), '--profile', 'public']);

    assert.match(run.error?.message ?? '', /--profile/);
    assert.ok((run.error?.message ?? '').includes(MANAGER_UPGRADE_USAGE), 'the usage of this command comes with the refusal');
    assert.equal(opened, 0);
  });

  it('passes the first use the deploy decided on to the operations it builds', async () => {
    const run = await upgrade(argvWith({}, ['--first-use']));

    assert.equal(run.error, null);
    assert.equal(settings?.firstUse, true);
  });

  it('leaves first use unset when the deploy found a host that has run the manager before', async () => {
    const run = await upgrade(argvWith());

    assert.equal(run.error, null);
    assert.equal(settings?.firstUse, false);
  });

  it('refuses a compose file given by a relative path, and says what the command takes', async () => {
    const run = await upgrade(argvWith({ '--compose-file': 'manager/docker-compose.yml' }));

    assert.match(run.error?.message ?? '', /--compose-file/);
    assert.ok((run.error?.message ?? '').includes(MANAGER_UPGRADE_USAGE), 'the usage of this command comes with the refusal');
    assert.equal(opened, 0, 'nothing on the host was opened');
  });

  it('refuses a compose file whose path walks up through itself', async () => {
    const run = await upgrade(argvWith({ '--compose-file': join(mutableRoot, 'deploy', '..', 'docker-compose.yml') + '/../docker-compose.yml' }));

    assert.match(run.error?.message ?? '', /--compose-file/);
    assert.equal(opened, 0);
  });

  it('refuses a compose file outside the tree this upgrade is allowed to replace', async () => {
    const run = await upgrade(argvWith({ '--compose-file': join(root, 'elsewhere', 'docker-compose.yml') }));

    assert.match(run.error?.message ?? '', /--compose-file/);
    assert.match(run.error?.message ?? '', /--mutable-root/);
    assert.equal(opened, 0);
  });

  it('keeps what the migration logs out of the one line on standard output the deploy reads', async () => {
    // What the command line does before it dispatches, so a migration cannot write into the answer.
    Logger.getInstance().writeEverythingToStandardError();
    const written: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      await runManagerUpgradeCommand(argvWith(), processStreams, {
        versionsRoot,
        operations: () => ({
          operations: {
            ...operations(),
            migrate: async () => {
              Logger.getInstance().info('[Database] Applied migration: 030_drop_bundled_shipments.sql');
            },
          },
          close: async () => {},
        }),
      });
    } finally {
      process.stdout.write = original;
    }

    assert.equal(written.length, 1, 'exactly one line reaches the standard output the deploy reads');
    assert.equal(JSON.parse(written[0]!).bundled.state, 'ready');
  });

  for (const [shape, outcome] of [
    ['failed', { state: 'failed', commit: PIN, buildId: null, problem: 'could not reach github' }],
    ['timed out', { state: 'timed-out', commit: PIN, buildId: null, problem: null }],
  ] as const) {
    it(`prints the outcome and refuses when the bundled build ${shape}, after letting the host go`, async () => {
      bundled = outcome;

      const run = await upgrade(argvWith());

      assert.equal(run.stdout.length, 1, 'the deploy still gets its one line');
      assert.deepEqual(JSON.parse(run.stdout[0]!).bundled, outcome);
      assert.match(run.error?.message ?? '', /bundled/i);
      assert.match(run.error?.message ?? '', /Versions page/);
      assert.equal(existsSync(managerUpgradeGuardRootFor(versionsRoot)), false, 'the manager is up, so nothing is held for a person');
      assert.deepEqual(run.stderr, [], 'and no retained guard is reported, because there is none');
    });
  }

  it('says nothing is wrong when the manager pins no commit to build', async () => {
    bundled = { state: 'unpinned', commit: null, buildId: null, problem: null };

    const run = await upgrade(argvWith());

    assert.equal(run.error, null);
    assert.equal(JSON.parse(run.stdout[0]!).bundled.state, 'unpinned');
  });

  it('refuses without owning anything when the host could not be opened at all', async () => {
    factoryFailure = new Error('synthetic connection refused');

    const run = await upgrade(argvWith());

    assert.match(run.error?.message ?? '', /connection refused/);
    assert.equal(existsSync(managerUpgradeGuardRootFor(versionsRoot)), false, 'nothing was owned');
    assert.deepEqual(run.stdout, []);
    assert.equal(closed, 0, 'and there was nothing to let go of');
  });

  it('names the guard this run is still holding, and the phase it stopped in', async () => {
    overrides = { verifyProject: async () => { throw new Error('synthetic health failure'); } };

    const run = await upgrade(argvWith());

    assert.match(run.error?.message ?? '', /synthetic health failure/);
    const guard = managerUpgradeGuardRootFor(versionsRoot);
    const said = run.stderr.join('\n');
    assert.ok(said.includes(guard), 'the directory a person has to look at is named');
    assert.ok(said.includes('verifying'), 'so is the phase it stopped in');
    assert.match(said, /A person checks the host before removing that directory\./);
    assert.equal(existsSync(guard), true, 'the guard is never removed by the run that left it');
    assert.equal(closed, 1, 'and what it opened is let go of');
  });

  it('names the retained directory and the phase it stopped in when an earlier upgrade still holds the host', async () => {
    const guard = managerUpgradeGuardRootFor(versionsRoot);
    await mkdir(guard, { mode: 0o700 });
    await writeFile(join(guard, 'owner.json'),
      JSON.stringify({ schema: 1, ownerId: MANAGER_COMMIT, request: {}, phase: HELD_PHASE }), { mode: 0o600 });

    const run = await upgrade(argvWith());

    assert.match(run.error?.message ?? '', /owned|progress/i);
    const said = run.stderr.join('\n');
    assert.ok(said.includes(guard), 'the directory a person has to look at is named');
    assert.ok(said.includes(HELD_PHASE), 'so is the phase the earlier upgrade stopped in');
    assert.match(said, /A person checks the host before removing that directory\./);
    assert.equal(existsSync(guard), true, 'the guard is never removed by a rerun');
    assert.equal(closed, 1, 'and what the refused run opened is let go of again');
  });

  it('builds its host operations from the flags it was given', async () => {
    const composeFile = join(mutableRoot, 'docker-compose.yml');

    const run = await upgrade(argvWith({ '--compose-file': composeFile }, ['--public-edge']));

    assert.equal(run.error, null);
    assert.deepEqual(settings, {
      versionsRoot, composeFile, bundledStackRoot: BUNDLED_STACK_ROOT, publicEdge: true, firstUse: false,
      postgresVolume: MANAGER_POSTGRES_VOLUME,
      apiHealthUrl: `http://api:${config.port}/health`,
      timeouts: { bundledBuild: Number(BUNDLED_TIMEOUT) * 1000 },
    });
  });
});
