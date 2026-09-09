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

import { runManagerUpgradeCommand } from '../../../src/cli/managerUpgrade.js';
import type { BundledShipmentReceipt } from '../../../src/domain/versions/BundledShipment.js';
import type { ManagerUpgradeOperations } from '../../../src/domain/versions/ManagerUpgrade.js';
import { managerUpgradeGuardRootFor } from '../../../src/domain/versions/stackPaths.js';

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

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 't04b-upgrade-command-'));
    versionsRoot = join(root, 'versions'); mutableRoot = join(root, 'manager');
    await mkdir(versionsRoot); await mkdir(mutableRoot);
    opened = 0; closed = 0; revision = '0';
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

  function argvWith(overrides: Record<string, string> = {}, publicEdge = false): string[] {
    const flags: Record<string, string> = {
      '--shipment-id': SHIPMENT_ID, '--commit': COMMIT, '--digest': DIGEST,
      '--manager-commit': MANAGER_COMMIT, '--manager-digest': MANAGER_DIGEST, '--image-id': IMAGE_ID,
      '--project': 'manager', '--compose-file': join(mutableRoot, 'docker-compose.yml'),
      '--mutable-root': mutableRoot, '--toolchain': TOOLCHAIN, ...overrides,
    };
    return [...Object.entries(flags).flat(), ...(publicEdge ? ['--public-edge'] : [])];
  }

  async function upgrade(argv: string[]): Promise<CommandRun> {
    const stdout: string[] = []; const stderr: string[] = []; let error: Error | null = null;
    try {
      await runManagerUpgradeCommand(argv, { out: (line) => stdout.push(line), err: (line) => stderr.push(line) }, {
        versionsRoot,
        operations: () => {
          opened += 1;
          return { operations: operations(), close: async () => { closed += 1; } };
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

  it('refuses an option it does not take rather than guessing at it', async () => {
    const run = await upgrade([...argvWith(), '--profile', 'public']);

    assert.match(run.error?.message ?? '', /--profile/);
    assert.equal(opened, 0);
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
  });
});
