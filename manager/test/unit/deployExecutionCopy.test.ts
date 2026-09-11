/**
 * Every deployment runs from a private copy of its build, never in the build.
 *
 * Unit test, no database and no Docker, but the copies are real files.
 * `pnpm test` in manager/.
 *
 * A deploy used to run the stack's scripts with the build directory as its
 * working directory and write its own env files there, so a build stopped
 * being the bytes it was published as after the first deploy from it, and two
 * deployments of one build shared one mutable tree. Now the claim's build is
 * copied into a directory of its own, registered against the job reference the
 * deploy already holds, and the scripts run there.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import type { StackContract } from '@streaming-infra-manager/common';

import type { Profile } from '../../src/types/index.js';

import { throwawayRoot } from '../support/throwawayRoot.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

const root = throwawayRoot('deploy-execution-');
process.env.SHLS_ROOT = join(root, 'bundled');
process.env.BEE_DATA_ROOT = join(root, 'data');
mkdirSync(join(root, 'bundled'), { recursive: true });
writeFileSync(join(root, 'bundled', '.env'), 'ENGINE=srs\n');

const { ExecutionRootService } = await import('../../src/domain/versions/ExecutionRootService.js');
const { BUILD_COMPLETE_MARKER, BUILD_MANIFEST_FILE } = await import('../../src/domain/versions/buildManifest.js');
const { inventoryOwnedTree } = await import('../../src/domain/versions/ownedTreeInventory.js');
const { buildDirFor, executionsRootFor } = await import('../../src/domain/versions/stackPaths.js');
const { InMemoryExecutionRoots } = await import('../support/InMemoryExecutionRoots.js');
const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness, untilRunning } = await import('../support/orchestratorHarness.js');

const CONTRACT: StackContract = { ...ALLOCATION_CONTRACT, ports: [...ALLOCATION_CONTRACT.ports] };
const COMMIT_A = 'a'.repeat(40);

/** A complete build on disk, with the sample a deploy bootstraps from. */
function buildOnDisk(versionsRoot: string, buildId: string): string {
  const dir = buildDirFor(versionsRoot, 'v3', buildId);
  mkdirSync(join(dir, 'deploy', 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'deploy', 'scripts', 'deploy.sh'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(dir, '.env.sample'), 'ENGINE=srs\n');
  writeFileSync(join(dir, BUILD_MANIFEST_FILE), JSON.stringify({ commit: buildId.slice(0, 40), buildId, builtAt: new Date().toISOString(), toolchain: 't' }));
  writeFileSync(join(dir, BUILD_COMPLETE_MARKER), '');
  return dir;
}

async function setup(options: { copies?: boolean } = {}) {
  const versionsRoot = mkdtempSync(join(root, 'versions-'));
  const profiles = [makeProfile({ name: 'stage', stack_version_id: 2, stamp_id: 'a'.repeat(64), instance_id: randomUUID() })];
  const store = new InMemoryExecutionRoots(executionsRootFor(versionsRoot), name => {
    const found = harness.profiles.rows.get(name);
    return found?.instance_id;
  });
  const service = new ExecutionRootService(store, executionsRootFor(versionsRoot));
  const harness = orchestratorHarness(profiles, undefined, versionsRoot, undefined, undefined,
    options.copies === false ? undefined : service);
  const v3 = await harness.versions.insert({ name: 'v3', gitRef: 'main-v3', rootPath: join(versionsRoot, 'v3') });
  buildOnDisk(versionsRoot, COMMIT_A);
  await harness.versions.publish(v3.id, { buildId: COMMIT_A, commitSha: COMMIT_A, contract: CONTRACT });
  const row = () => {
    const found = harness.profiles.rows.get('stage');
    if (!found) throw new Error('stage is gone');
    return found;
  };
  return { harness, store, service, v3, row, versionsRoot };
}

async function deploy(harness: Awaited<ReturnType<typeof setup>>['harness'], row: () => Profile) {
  const reservation = await harness.orchestrator.reserveDeploy(row(), undefined);
  await harness.orchestrator.runReserved(reservation, row());
  harness.runner.finish(harness.runner.runs.length - 1);
  await untilRunning(harness.profiles, 'stage');
  return harness.runner.runs[harness.runner.runs.length - 1]!;
}

async function until(done: () => boolean, what: string): Promise<void> {
  for (let tick = 0; tick < 300; tick += 1) {
    if (done()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(what);
}

describe('the tree a deploy runs in', () => {
  it('is a private copy of the captured build, and the build is left exactly as it was', async () => {
    const { harness, store, row, versionsRoot } = await setup();
    const build = buildDirFor(versionsRoot, 'v3', COMMIT_A);
    const before = await inventoryOwnedTree(build);

    const run = await deploy(harness, row);

    const record = store.records[0]!;
    assert.equal(run.options.cwd, record.root, 'the job ran in its own copy');
    assert.equal(run.script, join(record.root, 'deploy', 'scripts', 'deploy.sh'));
    assert.notEqual(record.root, build);
    assert.deepEqual(await inventoryOwnedTree(build), before, 'the build was not written into');
    assert.equal(await readFile(join(record.root, '.env.sample'), 'utf8'), 'ENGINE=srs\n');
    assert.match(await readFile(join(record.root, '.env.stage'), 'utf8'), /ENGINE=/);
  });

  it('is the build itself when no copies are configured, exactly as before they existed', async () => {
    const { harness, row, versionsRoot } = await setup({ copies: false });

    const run = await deploy(harness, row);

    assert.equal(run.options.cwd, buildDirFor(versionsRoot, 'v3', COMMIT_A));
  });

  it('is a copy readable only by the manager that made it', async () => {
    const { harness, store, row } = await setup();

    await deploy(harness, row);

    assert.equal((await stat(dirname(store.records[0]!.root))).mode & 0o777, 0o700);
  });

  it('is recorded as launched before the script can have started', async () => {
    const { harness, store, row } = await setup();
    const seen: (string | null)[] = [];
    harness.runner.onStart = () => { seen.push(store.stateOf(store.records[0]!.executionId)); };

    await deploy(harness, row);

    assert.deepEqual(seen, ['launch-uncertain'], 'the state was written before the spawn');
  });

  it('goes with a deploy that never spawned anything, and the job is cancelled', async () => {
    const { harness, store, row, versionsRoot } = await setup();
    const reservation = await harness.orchestrator.reserveDeploy(row(), undefined);
    harness.daemon.snapshot = async () => { throw new Error('the daemon did not answer'); };

    await assert.rejects(harness.orchestrator.runReserved(reservation, row()), /did not answer/);

    assert.equal(harness.runner.runs.length, 0, 'nothing was spawned');
    assert.deepEqual(store.records.map(record => record.state), ['released']);
    assert.deepEqual(await readdir(executionsRootFor(versionsRoot)), []);
    assert.equal(harness.ledger.openJobReferences('stage').length, 0);
  });
});

describe('the copies a deployment keeps', () => {
  it('are the current one and the one before it, until a deploy comes up', async () => {
    const { harness, store, row, versionsRoot } = await setup();

    await deploy(harness, row);
    await deploy(harness, row);
    await deploy(harness, row);

    // Retiring happens after the deploy is RUNNING and is not awaited by it,
    // so this waits for the state it is about rather than for the machine.
    await until(() => store.records.filter(record => record.state !== 'released').length === 1,
      'the copies this deploy replaced were never retired');
    const live = store.records.filter(record => record.state !== 'released');
    assert.equal(live.length, 1, 'a deploy that came up leaves only the copy it runs from');
    assert.equal(live[0]!.executionId, store.records[store.records.length - 1]!.executionId);
    assert.deepEqual(await readdir(executionsRootFor(versionsRoot)), [live[0]!.executionId]);
  });

  it('are none once the deployment is removed', async () => {
    const { harness, store, row, versionsRoot } = await setup();
    await deploy(harness, row);

    await harness.orchestrator.startRemove(row());
    harness.daemon.containers.delete('stage');
    harness.runner.finish(harness.runner.runs.length - 1);
    await until(() => !harness.profiles.rows.has('stage'), 'stage was never removed');
    await until(() => store.records.every(record => record.state === 'released'),
      'the copy of a removed deployment was never released');

    assert.deepEqual(store.records.map(record => record.state), ['released']);
    assert.deepEqual(await readdir(executionsRootFor(versionsRoot)), []);
  });
});

describe('the other verbs', () => {
  it('stop and health run in the copy the deploy is running from', async () => {
    const { harness, store, row } = await setup();
    await deploy(harness, row);
    const copy = store.records[0]!.root;

    await harness.orchestrator.startStop(row(), undefined);
    const stopped = harness.runner.runs[harness.runner.runs.length - 1]!;
    await harness.orchestrator.startHealth(row());
    const health = harness.runner.runs[harness.runner.runs.length - 1]!;

    assert.equal(stopped.options.cwd, copy);
    assert.equal(stopped.script, join(copy, 'deploy', 'scripts', 'stop.sh'));
    assert.equal(health.options.cwd, copy);
  });

  it('stop runs in the version tree for a deployment that has no copy', async () => {
    const { harness, row, versionsRoot } = await setup();

    await harness.orchestrator.startStop(row(), undefined);

    assert.equal(harness.runner.runs[harness.runner.runs.length - 1]!.options.cwd, buildDirFor(versionsRoot, 'v3', COMMIT_A));
  });
});
