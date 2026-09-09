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

import type { ComposeUpgradeSettings } from '../../../src/cli/ComposeUpgradeOperations.js';
import { processStreams } from '../../../src/cli/commandStreams.js';
import { MANAGER_UPGRADE_USAGE, runManagerUpgradeCommand } from '../../../src/cli/managerUpgrade.js';
import { Logger } from '../../../src/domain/Logger.js';
import { MANAGER_POSTGRES_VOLUME } from '../../../src/domain/versions/managerProject.js';
import type { BundledShipmentReceipt } from '../../../src/domain/versions/BundledShipment.js';
import type { ManagerUpgradeOperations } from '../../../src/domain/versions/ManagerUpgrade.js';
import { managerUpgradeGuardRootFor } from '../../../src/domain/versions/stackPaths.js';
import { config } from '../../../src/utils/config.js';

const SHIPMENT_ID = '3f1c2b64-5a2e-4d7b-8c19-6a0f4d2e8b71';
const COMMIT = 'a'.repeat(40);
const DIGEST = 'd'.repeat(64);
const MANAGER_COMMIT = 'b'.repeat(40);
const MANAGER_DIGEST = 'e'.repeat(64);
const IMAGE_ID = `sha256:${'f'.repeat(64)}`;
const TOOLCHAIN = 'node v22.9.0 pnpm 9.0.0 Linux/x86_64';
const HELD_PHASE = 'publishing';

interface CommandRun {
  stdout: string[];
  stderr: string[];
  error: Error | null;
}

describe('manager:upgrade', () => {
  let root: string; let versionsRoot: string; let mutableRoot: string;
  let opened: number; let closed: number; let receipt: BundledShipmentReceipt; let revision: string;
  let settings: ComposeUpgradeSettings | null;
  let factoryFailure: Error | null; let overrides: Partial<ManagerUpgradeOperations>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 't04b-upgrade-command-'));
    versionsRoot = join(root, 'versions'); mutableRoot = join(root, 'manager');
    await mkdir(versionsRoot); await mkdir(mutableRoot);
    opened = 0; closed = 0; revision = '0'; settings = null;
    factoryFailure = null; overrides = {};
    receipt = { shipmentId: SHIPMENT_ID, versionId: 1, buildId: `${COMMIT}-r7`, publicationRevision: '1', publishedAt: new Date('2026-09-09T10:00:00.000Z') };
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  function operations(): ManagerUpgradeOperations {
    return {
      readPublication: async () => ({ schema: 'journal', revision, buildId: revision === '0' ? null : receipt.buildId,
        receipt: revision === '0' ? null : receipt, pending: null }),
      stopApi: async () => {},
      installSources: async () => {},
      publish: async () => { revision = receipt.publicationRevision; return receipt; },
      startProject: async () => {},
      verifyProject: async () => {},
    };
  }

  function argvWith(overrides: Record<string, string> = {}, switches: readonly string[] = []): string[] {
    const flags: Record<string, string> = {
      '--shipment-id': SHIPMENT_ID, '--commit': COMMIT, '--digest': DIGEST,
      '--manager-commit': MANAGER_COMMIT, '--manager-digest': MANAGER_DIGEST, '--image-id': IMAGE_ID,
      '--project': 'manager', '--compose-file': join(mutableRoot, 'docker-compose.yml'),
      '--mutable-root': mutableRoot, '--toolchain': TOOLCHAIN, ...overrides,
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

  it('prints one line naming the state and the receipt the publication returned', async () => {
    const run = await upgrade(argvWith());

    assert.equal(run.error, null);
    assert.equal(run.stdout.length, 1);
    assert.deepEqual(JSON.parse(run.stdout[0]!), {
      state: 'completed',
      receipt: { shipmentId: SHIPMENT_ID, versionId: 1, buildId: receipt.buildId, publicationRevision: '1', publishedAt: '2026-09-09T10:00:00.000Z' },
    });
    assert.deepEqual(run.stderr, []);
    assert.equal(closed, 1, 'what the upgrade opened is let go of again');
  });

  for (const [flag, value] of [
    ['--shipment-id', 'not-a-shipment'],
    ['--commit', 'zzzz'],
    ['--digest', 'too-short'],
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

  for (const [shape, toolchain] of [
    ['a quote', "node v22.9.0' rm -rf /"],
    ['a semicolon', 'node v22.9.0; rm -rf /'],
    ['a control character', 'node v22.9.0\nrm -rf /'],
  ] as const) {
    it(`refuses a toolchain carrying ${shape}, before it owns anything`, async () => {
      const run = await upgrade(argvWith({ '--toolchain': toolchain }));

      assert.match(run.error?.message ?? '', /--toolchain/);
      assert.equal(existsSync(managerUpgradeGuardRootFor(versionsRoot)), false, 'no guard directory was left behind');
      assert.equal(opened, 0, 'nothing on the host was opened');
    });
  }

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
    // What the command line does before it dispatches, so a migration cannot write into the receipt.
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
            publish: async () => {
              Logger.getInstance().info('[Database] Applied migration: 024_bundled_shipments.sql');
              revision = receipt.publicationRevision;
              return receipt;
            },
          },
          close: async () => {},
        }),
      });
    } finally {
      process.stdout.write = original;
    }

    assert.equal(written.length, 1, 'exactly one line reaches the standard output the deploy reads');
    assert.equal(JSON.parse(written[0]!).receipt.shipmentId, SHIPMENT_ID);
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
      JSON.stringify({ schema: 1, ownerId: SHIPMENT_ID, request: {}, phase: HELD_PHASE }), { mode: 0o600 });

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
      versionsRoot, composeFile, toolchain: TOOLCHAIN, publicEdge: true, firstUse: false,
      postgresVolume: MANAGER_POSTGRES_VOLUME,
      apiHealthUrl: `http://api:${config.port}/health`,
    });
  });
});
