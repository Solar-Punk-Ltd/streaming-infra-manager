/**
 * What an operator's own action tells a config file rollout that is under
 * way: the deployment moved, durably.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * A stop, a start, an edit's redeploy and a removal each move the intent
 * revision the rollout was started under and close its open operation, so a
 * watch that wakes later, or a manager that reboots later, finds the rollout
 * over rather than acting on a deployment the operator has moved on. The
 * rollout's own claim on the deployment moves nothing, because a rollout is
 * not the operator acting.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { throwawayRoot } from '../support/throwawayRoot.js';
import type { EngineConfigOperation } from '../../src/domain/engineConfig/operations.js';

const root = throwawayRoot('operator-intent-');
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');

const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness, untilRunning } = await import(
  '../support/orchestratorHarness.js'
);

async function until(what: string, condition: () => boolean): Promise<void> {
  for (let tick = 0; tick < 300; tick += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function setup() {
  const harness = orchestratorHarness([makeProfile({ name: 'stage', intent_revision: 3 })]);
  const row = () => {
    const found = harness.profiles.rows.get('stage');
    if (!found) throw new Error('stage is gone');
    return found;
  };
  const watching: EngineConfigOperation = {
    id: 7,
    profileName: 'stage',
    profileInstanceId: row().instance_id,
    engine: 'srs',
    kind: 'apply',
    previousConfig: 'listen 1935; # old\n',
    previousIsTemplate: false,
    recoveryDescriptor: null,
    recoveryReferenceId: null,
    deploymentJobReferenceId: null,
    sourceOperationId: null,
    appliedRevision: row().engine_config_revision,
    intentRevision: row().intent_revision,
    state: 'watching',
    containerId: 'c1',
    containerStartedAt: null,
    startedAt: new Date(0),
    recreateFinishedAt: new Date(0),
    watchStartedAt: new Date(0),
    finishedAt: null,
    message: null,
  };
  harness.operations.rows.push(watching);
  harness.profiles.write('stage', { engine_config_state: 'watching' });
  return { harness, row, watching };
}

describe('an operator action while a rollout is under way', () => {
  it('stop moves the intent and closes the open rollout, saying why', async () => {
    const { harness, row, watching } = setup();

    await harness.orchestrator.startStop(row(), undefined);
    harness.runner.finish(0);
    await until('the stop to finish', () => row().status === 'STOPPED');

    assert.equal(row().intent_revision, 4);
    assert.equal(watching.state, 'superseded');
    assert.match(watching.message ?? '', /Stopped by the operator/);
    assert.equal(row().engine_config_state, 'superseded');
  });

  it('a redeploy moves the intent and closes the open rollout', async () => {
    const { harness, row, watching } = setup();

    await harness.orchestrator.startDeploy(row(), undefined);
    harness.runner.finish(0);
    await untilRunning(harness.profiles, 'stage');

    assert.equal(row().intent_revision, 4);
    assert.equal(watching.state, 'superseded');
    assert.match(watching.message ?? '', /Redeployed by the operator/);
  });

  it('a removal closes the open rollout before the row goes', async () => {
    const { harness, row, watching } = setup();

    await harness.orchestrator.startRemove(row());
    harness.daemon.containers.delete('stage');
    harness.runner.finish(0);
    await until('the removal to finish', () => !harness.profiles.rows.has('stage'));

    assert.equal(watching.state, 'superseded');
    assert.match(watching.message ?? '', /was removed/);
  });

  it('a refused stop moves nothing, because the operator did not act on the deployment', async () => {
    const { harness, row, watching } = setup();
    harness.profiles.write('stage', { status: 'DEPLOYING' });

    await assert.rejects(harness.orchestrator.startStop(row(), undefined));

    assert.equal(row().intent_revision, 3);
    assert.equal(watching.state, 'watching');
  });

  it("the rollout's own claim moves nothing", async () => {
    const { harness, row, watching } = setup();

    const reservation = await harness.orchestrator.reserveForRollout(row(), 'srs');

    assert.equal(row().status, 'DEPLOYING');
    assert.equal(row().intent_revision, 3);
    assert.equal(watching.state, 'watching');
    await harness.orchestrator.cancelReservation(reservation);
  });
});

describe('what a deploy does with the hooks it was asked to run', () => {
  it('leaves a deployment RUNNING when the hook after it throws', async () => {
    const { harness, row } = setup();
    const reservation = await harness.orchestrator.reserveForRollout(row(), 'srs');

    await harness.orchestrator.runReserved(reservation, row(), {
      afterRunning: async () => {
        throw new Error('the bookkeeping failed');
      },
    });
    harness.runner.finish(0);
    await untilRunning(harness.profiles, 'stage');
    await until('the hook to have run', () => harness.profiles.markErrorCalls.length === 0);

    assert.equal(row().status, 'RUNNING');
    assert.deepEqual(harness.profiles.markErrorCalls, []);
  });

  it('keeps the script failure as the reason when the hook after a failure throws', async () => {
    const { harness, row } = setup();
    const reservation = await harness.orchestrator.reserveForRollout(row(), 'srs');

    await harness.orchestrator.runReserved(reservation, row(), {
      afterFailure: async () => {
        throw new Error('the recovery bookkeeping failed');
      },
    });
    harness.runner.finish(0, 1);
    await until('the failure to be recorded', () => row().status === 'ERROR');
    await until('the hook to have run', () => harness.profiles.markErrorCalls.length >= 1);

    assert.equal(harness.profiles.markErrorCalls.length, 1);
    assert.match(row().last_error ?? '', /exited with code 1/);
  });
});
