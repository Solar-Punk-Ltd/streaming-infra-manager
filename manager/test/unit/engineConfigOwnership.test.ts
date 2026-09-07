/**
 * Who owns a config file rollout, and what a rollout that lost ownership may
 * still do: nothing.
 *
 * Unit test, no database, no Docker and no deploy script. `pnpm test` in
 * manager/. The watch runs at millisecond timings.
 *
 * A delayed watcher used to be able to put an older file back over a newer
 * save, recreate a stopped deployment, or act on a deployment of the same
 * name created after its own was removed, because the previous file lived
 * in a closure and nothing recorded whose the rollout was.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { StackContract } from '@streaming-infra-manager/common';

import type { ContainerState } from '../../src/domain/ContainerControl.js';
import type { EngineWatcher } from '../../src/domain/engineConfig/EngineConfigService.js';
import type {
  EngineConfigOperation,
  EngineConfigOperationState,
} from '../../src/domain/engineConfig/operations.js';

const root = mkdtempSync(join(tmpdir(), 'engine-config-ownership-'));
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
mkdirSync(join(root, 'engines', 'srs'), { recursive: true });
writeFileSync(join(root, 'engines', 'srs', 'srs.conf.template'), 'listen 1935;\n');
writeFileSync(join(root, 'engines', 'srs', 'entrypoint.sh'), '');

const { EngineConfigChecker } = await import(
  '../../src/domain/engineConfig/engineConfigCheck.js'
);
const { EngineConfigService } = await import(
  '../../src/domain/engineConfig/EngineConfigService.js'
);
const { profileRow, profileServiceHarness } = await import(
  '../support/profileServiceHarness.js'
);
const { InMemoryEngineConfigOperations } = await import(
  '../support/InMemoryEngineConfigOperations.js'
);

const V3_CONTRACT: StackContract = {
  ports: [],
  maxSlot: 99,
  requiredSecrets: [],
  engineDefaults: {},
  features: { srsApiPort: true, chequebookGate: false },
  chequebookMinBzz: null,
  engineConfig: { srs: true, ome: false },
  engineImages: { srs: 'ossrs/srs:6', ome: null },
  warnings: [],
};

const RUNNING: ContainerState = {
  id: 'c1',
  status: 'running',
  restartCount: 0,
  startedAt: '2026-09-08T10:00:00Z',
};
const RESTARTED: ContainerState = { ...RUNNING, restartCount: 2 };
const OLD = 'listen 1935; # old\n';
const A = 'listen 1935; # A\n';
const B = 'listen 1935; # B\n';

/** Answers what the test puts in `states`, the last one repeating, or throws when told to. */
class ScriptedWatcher implements EngineWatcher {
  states: (ContainerState | null)[] = [RUNNING];
  failing = false;

  async inspect(): Promise<ContainerState | null> {
    if (this.failing) throw new Error('the daemon did not answer');
    return this.states.length > 1 ? this.states.shift()! : (this.states[0] ?? null);
  }

  async logs(): Promise<string> {
    return 'invalid config, exiting';
  }
}

async function setup() {
  const harness = profileServiceHarness([profileRow()]);
  await harness.versions.setContract(1, V3_CONTRACT);
  harness.profiles.engineConfigs.set('stream1', OLD);
  const operations = new InMemoryEngineConfigOperations(harness.profiles);
  const watcher = new ScriptedWatcher();
  const service = new EngineConfigService(
    harness.profiles.asRepository(),
    harness.containers.asRepository(),
    harness.orchestrator.asOrchestrator(),
    harness.versions,
    watcher,
    new EngineConfigChecker(async () => ({ code: 0, stdout: 'test is successful', stderr: '' })),
    harness.events,
    operations,
    { intervalMs: 5, durationMs: 25 },
  );
  const row = () => {
    const found = harness.profiles.rows.get('stream1');
    if (!found) throw new Error('stream1 is gone');
    return found;
  };
  /** An operation left by a manager that is gone, the way boot finds it. */
  const leftBehind = (
    state: EngineConfigOperationState,
    over: Partial<EngineConfigOperation> = {},
  ): EngineConfigOperation => {
    const current = row();
    harness.profiles.engineConfigs.set('stream1', A);
    const operation: EngineConfigOperation = {
      id: 99,
      profileName: 'stream1',
      profileInstanceId: current.instance_id,
      engine: 'srs',
      kind: 'apply',
      previousConfig: OLD,
      previousIsTemplate: false,
      appliedRevision: current.engine_config_revision,
      intentRevision: current.intent_revision,
      state,
      containerId: 'c1',
      containerStartedAt: RUNNING.startedAt,
      startedAt: new Date(0),
      recreateFinishedAt: new Date(0),
      watchStartedAt: state === 'watching' ? new Date(0) : null,
      finishedAt: null,
      message: null,
      ...over,
    };
    operations.rows.push(operation);
    harness.profiles.write('stream1', { engine_config_state: state });
    return operation;
  };
  return { harness, operations, watcher, service, row, leftBehind, states: () => operations.rows.map((o) => o.state) };
}

const settle = (ms = 90) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a rollout that lost ownership', () => {
  it('is superseded by the next apply, and its last healthy tick cannot relabel it applied', async () => {
    const { service, harness, states } = await setup();

    await service.apply('stream1', A);
    await settle(10);
    await service.apply('stream1', B);
    await settle();

    assert.deepEqual(states(), ['superseded', 'applied']);
    assert.equal(harness.profiles.engineConfigs.get('stream1'), B);
    assert.equal(harness.orchestrator.deploys.length, 2);
  });

  it('leaves a stopped deployment stopped when its container is gone', async () => {
    const { service, harness, operations, watcher, row } = await setup();

    await service.apply('stream1', A);
    await settle(10);
    // Stop, as the stop path does it: the intent moves, the open operation is
    // over, the row is STOPPED. The watcher then finds no container.
    await harness.profiles.bumpIntent('stream1');
    await operations.supersedeOpen(row().instance_id, 'stopped by the operator');
    harness.profiles.write('stream1', { status: 'STOPPED' });
    watcher.states.push(null);
    await settle();

    assert.equal(row().status, 'STOPPED');
    assert.equal(harness.orchestrator.deploys.length, 1, 'nothing was recreated');
    assert.equal(harness.profiles.engineConfigs.get('stream1'), A);
  });

  it('writes nothing and launches nothing from a failure callback once ownership is gone', async () => {
    const { service, harness, operations, row, states } = await setup();
    harness.orchestrator.exitCodes.set('stream1', 1);

    await service.apply('stream1', A);
    // Before the script reports its exit: the operator stops the deployment.
    await harness.profiles.bumpIntent('stream1');
    await operations.supersedeOpen(row().instance_id, 'stopped by the operator');
    await settle();

    assert.deepEqual(states(), ['superseded']);
    assert.equal(harness.profiles.engineConfigs.get('stream1'), A, 'no revert write');
    assert.equal(harness.orchestrator.deploys.length, 1, 'no recovery launched');
  });
});

describe('a recreate that fails', () => {
  it('puts the previous file back, tries once, and keeps both reasons', async () => {
    const { service, harness, states, row, operations } = await setup();
    harness.orchestrator.exitCodes.set('stream1', 1);

    await service.apply('stream1', A);
    await settle();

    assert.deepEqual(states(), ['failed']);
    assert.equal(harness.profiles.engineConfigs.get('stream1'), OLD);
    assert.equal(harness.orchestrator.deploys.length, 2, 'the previous file was recreated on, once');
    assert.match(operations.rows[0]?.message ?? '', /exited with code 1/);
    assert.equal(row().status, 'RUNNING');
    assert.equal(row().engine_config_state, 'failed');
  });
});

describe('what boot does with a rollout a gone manager left open', () => {
  it('marks one still applying as interrupted, writing nothing', async () => {
    const { service, harness, leftBehind, states, row } = await setup();
    leftBehind('applying');
    harness.profiles.write('stream1', { status: 'ERROR' });

    await service.reconcileAtBoot();
    await settle();

    assert.deepEqual(states(), ['interrupted']);
    assert.equal(row().engine_config_state, 'interrupted');
    assert.equal(harness.profiles.engineConfigs.get('stream1'), A);
    assert.deepEqual(harness.orchestrator.deploys, []);
  });

  it('runs a fresh watch on one that was watching a container still up and never restarted', async () => {
    const { service, leftBehind, states } = await setup();
    leftBehind('watching');

    await service.reconcileAtBoot();
    await settle();

    assert.deepEqual(states(), ['applied']);
  });

  it('reverts one that was watching a container that restarted meanwhile', async () => {
    const { service, harness, leftBehind, states, watcher } = await setup();
    leftBehind('watching');
    watcher.states = [RESTARTED];

    await service.reconcileAtBoot();
    await settle();

    assert.deepEqual(states(), ['reverted']);
    assert.equal(harness.profiles.engineConfigs.get('stream1'), OLD);
    assert.equal(harness.orchestrator.deploys.length, 1);
  });

  it('supersedes one whose container is not the one it watched', async () => {
    const { service, harness, leftBehind, states, watcher } = await setup();
    leftBehind('watching');
    watcher.states = [{ ...RUNNING, id: 'c2' }];

    await service.reconcileAtBoot();
    await settle();

    assert.deepEqual(states(), ['superseded']);
    assert.equal(harness.profiles.engineConfigs.get('stream1'), A);
    assert.deepEqual(harness.orchestrator.deploys, []);
  });

  it('marks one it cannot inspect as interrupted', async () => {
    const { service, leftBehind, states, watcher, harness } = await setup();
    leftBehind('watching');
    watcher.failing = true;

    await service.reconcileAtBoot();
    await settle();

    assert.deepEqual(states(), ['interrupted']);
    assert.deepEqual(harness.orchestrator.deploys, []);
  });

  it('never acts on a deployment of the same name created after its own was removed', async () => {
    const { service, harness, leftBehind, states } = await setup();
    leftBehind('watching', { profileInstanceId: 'instance-gone' });

    await service.reconcileAtBoot();
    await settle();

    assert.deepEqual(states(), ['superseded']);
    assert.deepEqual(harness.orchestrator.deploys, []);
    assert.equal(harness.profiles.engineConfigs.get('stream1'), A);
  });
});
