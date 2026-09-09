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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { StackContract } from '@streaming-infra-manager/common';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

import type { ContainerState } from '../../src/domain/ContainerControl.js';
import type { EngineWatcher } from '../../src/domain/engineConfig/EngineConfigService.js';
import type {
  EngineConfigOperation,
  EngineConfigOperationState,
} from '../../src/domain/engineConfig/operations.js';

const root = mkdtempSync(join(tmpdir(), 'engine-config-ownership-'));
after(() => rmSync(root, { recursive: true, force: true }));
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
const { configureEngineConfigAdmission } = await import('../support/engineConfigAdmissionFixture.js');

const V3_CONTRACT: StackContract = {
  ports: [...ALLOCATION_CONTRACT.ports],
  maxSlot: 99,
  allocationProblem: null,
  requiredSecrets: [],
  engineDefaults: {},
  features: { srsApiPort: true, chequebookGate: false, sharedImageTags: true },
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

/** A promise the test resolves, so a watch tick can be held inside inspect. */
function gate() {
  let open = () => undefined as void;
  const held = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { held, open };
}

/**
 * Answers what the test puts in `states`, the last one repeating, or throws
 * when told to. A tick that arrives while `hold` is set waits inside inspect
 * until the test opens it, which is how a test puts a healthy tick exactly
 * where it wants it.
 */
class ScriptedWatcher implements EngineWatcher {
  states: (ContainerState | null)[] = [RUNNING];
  failing = false;
  hold: Promise<void> | null = null;
  /** How many ticks are waiting on `hold` right now. */
  holding = 0;

  async inspect(): Promise<ContainerState | null> {
    if (this.failing) throw new Error('the daemon did not answer');
    if (this.hold) {
      this.holding += 1;
      await this.hold;
      this.holding -= 1;
    }
    return this.states.length > 1 ? this.states.shift()! : (this.states[0] ?? null);
  }

  async logs(): Promise<string> {
    return 'invalid config, exiting';
  }

  async reachable(): Promise<boolean> {
    return true;
  }
}

async function setup() {
  const harness = profileServiceHarness([profileRow()]);
  await harness.versions.setContract(1, V3_CONTRACT);
  harness.profiles.engineConfigs.set('stream1', OLD);
  const operations = new InMemoryEngineConfigOperations(harness.profiles);
  const version = await configureEngineConfigAdmission(harness, operations, root);
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
    { intervalMs: 5, durationMs: 25, probeBudgetMs: 20 },
  );
  const row = () => {
    const found = harness.profiles.rows.get('stream1');
    if (!found) throw new Error('stream1 is gone');
    return found;
  };
  /** An operation left by a manager that is gone, the way boot finds it. */
  const leftBehind = async (
    state: EngineConfigOperationState,
    over: Partial<EngineConfigOperation> = {},
  ): Promise<EngineConfigOperation> => {
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
      recoveryDescriptor: null,
      recoveryReferenceId: null,
      deploymentJobReferenceId: null,
      sourceOperationId: null,
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
    await operations.seedRecovery(operation, version);
    harness.profiles.write('stream1', { engine_config_state: state });
    return operation;
  };
  return { harness, operations, watcher, service, row, leftBehind, states: () => operations.rows.map((o) => o.state) };
}

const settle = (ms = 90) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for the condition, naming what it waited for when it never comes. Absence is still waited out with `settle`. */
async function until(what: string, condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await settle(2);
  }
}

describe('a rollout that lost ownership', () => {
  it('is superseded by the next apply, and its last healthy tick cannot relabel it applied', async () => {
    const { service, harness, states, watcher } = await setup();

    await service.apply('stream1', A);
    await until('the first rollout to be watching', () => states()[0] === 'watching');
    // One of the first rollout's ticks has passed its ownership check and is
    // held inside inspect. Everything the second rollout does happens while
    // it waits, so what the tick does when it resumes is the whole question.
    const tick = gate();
    watcher.hold = tick.held;
    await until('a tick of the first rollout to be held', () => watcher.holding === 1);
    watcher.hold = null;
    await service.apply('stream1', B);
    await until('the second rollout to finish', () => states()[1] === 'applied');
    tick.open();
    await settle(15);

    assert.deepEqual(states(), ['superseded', 'applied']);
    assert.equal(harness.profiles.engineConfigs.get('stream1'), B);
    assert.equal(harness.orchestrator.deploys.length, 2);
  });

  it('ends interrupted rather than watching forever when a read fails mid watch', async () => {
    const { service, harness, states, operations, row } = await setup();

    await service.apply('stream1', A);
    await until('the rollout to be watching', () => states()[0] === 'watching');
    operations.failNextRead = new Error('the database went away');
    await until('the rollout to end', () => states()[0] !== 'watching');

    assert.deepEqual(states(), ['interrupted']);
    assert.match(row().engine_config_error ?? '', /database went away/);
    assert.equal(harness.orchestrator.deploys.length, 1);
  });

  it('ends interrupted, and not still watching, when the engine cannot be inspected mid watch', async () => {
    const { service, harness, states, watcher, row } = await setup();

    await service.apply('stream1', A);
    await until('the rollout to be watching', () => states()[0] === 'watching');
    watcher.failing = true;
    await until('the rollout to end', () => states()[0] !== 'watching');

    assert.deepEqual(states(), ['interrupted']);
    assert.equal(row().engine_config_state, 'interrupted');
    assert.match(row().engine_config_error ?? '', /could not be inspected/);
    assert.equal(harness.orchestrator.deploys.length, 1, 'nothing was recreated');
  });

  it('leaves a stopped deployment stopped when its container is gone', async () => {
    const { service, harness, operations, watcher, row, states } = await setup();

    await service.apply('stream1', A);
    await until('the rollout to be watching', () => states()[0] === 'watching');
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
    await until('the rollout to end', () => states()[0] === 'failed');

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
    await leftBehind('applying');
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
    await leftBehind('watching');

    await service.reconcileAtBoot();
    await until('the fresh watch to finish', () => states()[0] === 'applied');

    assert.deepEqual(states(), ['applied']);
  });

  it('supersedes one watching a deployment that is not running any more, and recreates nothing', async () => {
    const { service, harness, leftBehind, states, watcher, row } = await setup();
    await leftBehind('watching');
    // Stopped by an older manager that did not close the operation, or by a
    // stop the crash cut short. The container is gone, and that is not
    // failure evidence: nothing may recreate a stopped deployment.
    harness.profiles.write('stream1', { status: 'STOPPED' });
    watcher.states = [null];

    await service.reconcileAtBoot();
    await settle();

    assert.deepEqual(states(), ['superseded']);
    assert.equal(row().status, 'STOPPED');
    assert.deepEqual(harness.orchestrator.deploys, []);
    assert.equal(harness.profiles.engineConfigs.get('stream1'), A);
  });

  it('reverts one that was watching a container that restarted meanwhile', async () => {
    const { service, harness, leftBehind, states, watcher } = await setup();
    await leftBehind('watching');
    watcher.states = [RESTARTED];

    await service.reconcileAtBoot();
    await until('the revert to finish', () => states()[0] === 'reverted');

    assert.deepEqual(states(), ['reverted']);
    assert.equal(harness.profiles.engineConfigs.get('stream1'), OLD);
    assert.equal(harness.orchestrator.deploys.length, 1);
  });

  it('supersedes one whose container is not the one it watched', async () => {
    const { service, harness, leftBehind, states, watcher } = await setup();
    await leftBehind('watching');
    watcher.states = [{ ...RUNNING, id: 'c2' }];

    await service.reconcileAtBoot();
    await settle();

    assert.deepEqual(states(), ['superseded']);
    assert.equal(harness.profiles.engineConfigs.get('stream1'), A);
    assert.deepEqual(harness.orchestrator.deploys, []);
  });

  it('marks one it cannot inspect as interrupted', async () => {
    const { service, leftBehind, states, watcher, harness } = await setup();
    await leftBehind('watching');
    watcher.failing = true;

    await service.reconcileAtBoot();
    await settle();

    assert.deepEqual(states(), ['interrupted']);
    assert.deepEqual(harness.orchestrator.deploys, []);
  });

  it('never acts on a deployment of the same name created after its own was removed', async () => {
    const { service, harness, leftBehind, states } = await setup();
    await leftBehind('watching', { profileInstanceId: 'instance-gone' });

    await service.reconcileAtBoot();
    await settle();

    assert.deepEqual(states(), ['superseded']);
    assert.deepEqual(harness.orchestrator.deploys, []);
    assert.equal(harness.profiles.engineConfigs.get('stream1'), A);
  });
});

describe('what the operator does with an interrupted rollout', () => {
  it('verifies the stored file again, as a rollout of its own that supersedes the interrupted one', async () => {
    const { service, harness, leftBehind, states } = await setup();
    await leftBehind('interrupted');

    await service.verifyNow('stream1');
    await until('the new rollout to finish', () => states()[1] === 'applied');

    assert.deepEqual(states(), ['superseded', 'applied']);
    assert.equal(harness.profiles.engineConfigs.get('stream1'), A);
    assert.equal(harness.orchestrator.deploys.length, 1);
  });

  it('verifies an interrupted reset by recreating on the template, so the operation does not stay open', async () => {
    const { service, harness, leftBehind, states, row } = await setup();
    await leftBehind('interrupted', { kind: 'reset' });
    harness.profiles.engineConfigs.delete('stream1');
    harness.profiles.write('stream1', { has_engine_config: false });

    await service.verifyNow('stream1');
    await until('the new rollout to finish', () => states()[1] === 'applied');

    assert.deepEqual(states(), ['superseded', 'applied']);
    assert.equal(row().has_engine_config, false);
    assert.equal(harness.orchestrator.deploys.length, 1);
  });

  it('goes back to the previous file the interrupted rollout recorded, through a rollout of its own', async () => {
    const { service, harness, leftBehind, states } = await setup();
    await leftBehind('interrupted');

    await service.recreateOnPrevious('stream1');
    await until('the previous rollout to be restored', () => states()[1] === 'reverted');

    assert.deepEqual(states(), ['superseded', 'reverted']);
    assert.equal(harness.profiles.engineConfigs.get('stream1'), OLD);
    assert.equal(harness.orchestrator.deploys.length, 1);
  });

  it('refuses to go back when no rollout is interrupted', async () => {
    const { service, harness } = await setup();

    await assert.rejects(
      service.recreateOnPrevious('stream1'),
      /no interrupted rollout/,
    );
    assert.deepEqual(harness.orchestrator.deploys, []);
  });
});
