/**
 * Two deploys cannot create containers in one project at once, and two
 * shared-tag builds cannot run on one daemon at once.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * The stack names its built images by service alone, so a container could
 * be created from the other project's image while both built. Every deploy
 * attempt now holds its project until it resolves by evidence, and an
 * attempt on a version with shared tags holds the daemon against every
 * other such attempt. A manager that comes back finds the rows.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { StackContract } from '@streaming-infra-manager/common';

import { DeployAttemptRefusedError } from '../../src/domain/errors/index.js';

const root = mkdtempSync(join(tmpdir(), 'deploy-guard-'));
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');

const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness, untilRunning } = await import('../support/orchestratorHarness.js');

const contract = (sharedImageTags: boolean): StackContract => ({
  ports: [],
  maxSlot: 999,
  requiredSecrets: [],
  engineDefaults: {},
  features: { srsApiPort: false, chequebookGate: false, sharedImageTags },
  chequebookMinBzz: null,
  engineConfig: { srs: false, ome: false },
  engineImages: { srs: null, ome: null },
  warnings: [],
});

async function setup(sharedImageTags = true) {
  const harness = orchestratorHarness([
    makeProfile({ name: 'stage', stamp_id: 'a'.repeat(64) }),
    makeProfile({ name: 'other', port_slot: 2, stamp_id: 'a'.repeat(64) }),
  ]);
  await harness.versions.setContract(1, contract(sharedImageTags));
  // These tests say what the containers show. Nothing is recreated on its own.
  harness.daemon.autoRecreate = false;
  harness.daemon.set('stage', 'srs', ['c-srs-1']);
  harness.daemon.set('stage', 'stream-uploader', ['c-up-1']);
  harness.daemon.set('stage', 'bee-uploader', ['c-bee-1']);
  const row = (name: string) => harness.profiles.rows.get(name)!;
  /** What a deploy that recreated every container leaves behind. */
  const recreated = (project: string) => {
    for (const service of ['srs', 'stream-uploader', 'bee-uploader']) harness.daemon.set(project, service, [`${service}-new`]);
  };
  return { harness, row, recreated };
}

async function untilStatus(harness: Awaited<ReturnType<typeof setup>>['harness'], name: string, status: string): Promise<void> {
  for (let tick = 0; tick < 300; tick += 1) {
    if (harness.profiles.statusOf(name) === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${name} never reached ${status}`);
}

describe('a deploy attempt', () => {
  it('is opened before the script runs, with the project\'s containers as they were and the services it touches', async () => {
    const { harness, row } = await setup();

    await harness.orchestrator.startDeploy(row('stage'), undefined);

    const [attempt] = harness.attempts.rows;
    assert.equal(attempt?.project, 'stage');
    assert.equal(attempt?.kind, 'shared');
    assert.equal(attempt?.daemonId, 'daemon-1');
    assert.deepEqual([...(attempt?.preJobContainerIds ?? [])].sort(), ['c-bee-1', 'c-srs-1', 'c-up-1']);
    assert.deepEqual([...(attempt?.services ?? [])].sort(), ['bee-uploader', 'srs', 'stream-uploader']);
    assert.equal(harness.runner.runs.length, 1, 'the script ran once the attempt was open');
  });

  it('is fixed-image on a version whose built services name no image', async () => {
    const { harness, row } = await setup(false);

    await harness.orchestrator.startDeploy(row('stage'), undefined);

    assert.equal(harness.attempts.rows[0]?.kind, 'fixed');
  });

  it('releases when the script ends and every touched service shows a new container', async () => {
    const { harness, row, recreated } = await setup();
    await harness.orchestrator.startDeploy(row('stage'), undefined);

    recreated('stage');
    harness.runner.finish(0);
    await untilRunning(harness.profiles, 'stage');

    assert.equal(harness.attempts.rows[0]?.state, 'released');
  });

  it('blocks, naming the service, when the script ended with a touched service still on an old container', async () => {
    const { harness, row } = await setup();
    await harness.orchestrator.startDeploy(row('stage'), undefined);

    harness.daemon.set('stage', 'srs', ['srs-new']);
    harness.runner.finish(0);
    await untilRunning(harness.profiles, 'stage');

    assert.equal(harness.attempts.rows[0]?.state, 'blocked');
    assert.match(harness.attempts.rows[0]?.reason ?? '', /stream-uploader/);
    assert.equal(harness.profiles.statusOf('stage'), 'RUNNING', 'the deployment itself came up');
  });

  it('blocks when the script fails and nothing new was created', async () => {
    const { harness, row } = await setup();
    await harness.orchestrator.startDeploy(row('stage'), undefined);

    harness.runner.finish(0, 1);
    await untilStatus(harness, 'stage', 'ERROR');

    assert.equal(harness.attempts.rows[0]?.state, 'blocked');
  });
});

describe('what an unresolved attempt refuses', () => {
  it('refuses the same project, naming the attempt, and takes no claim', async () => {
    const { harness, row } = await setup();
    await harness.orchestrator.startDeploy(row('stage'), undefined);
    harness.runner.finish(0);
    await untilRunning(harness.profiles, 'stage');
    assert.equal(harness.attempts.rows[0]?.state, 'blocked');

    await assert.rejects(
      harness.orchestrator.startDeploy(row('stage'), undefined),
      (err: unknown) => err instanceof DeployAttemptRefusedError && /stage/.test(err.reason) && /job-|attempt/.test(err.reason),
    );
    assert.equal(harness.profiles.statusOf('stage'), 'RUNNING');
    assert.equal(harness.attempts.rows.length, 1);
  });

  it('refuses a shared-tag deploy of another project while a shared-tag attempt runs, and admits a fixed-image one', async () => {
    const { harness, row } = await setup();
    await harness.orchestrator.startDeploy(row('stage'), undefined);

    await assert.rejects(
      harness.orchestrator.startDeploy(row('other'), undefined),
      (err: unknown) => err instanceof DeployAttemptRefusedError && /stage/.test(err.reason),
    );
    assert.equal(harness.profiles.statusOf('other'), 'RUNNING');

    await harness.versions.setContract(1, contract(false));
    await harness.orchestrator.startDeploy(row('other'), undefined);
    assert.equal(harness.attempts.rows.length, 2);
  });

  it('is admitted again once a person released the blocked attempt', async () => {
    const { harness, row } = await setup();
    await harness.orchestrator.startDeploy(row('stage'), undefined);
    harness.runner.finish(0);
    await untilRunning(harness.profiles, 'stage');

    const released = await harness.orchestrator.releaseAttempt(harness.attempts.rows[0]!.id, 'levi');
    assert.equal(released?.releasedBy, 'levi');

    await harness.orchestrator.startDeploy(row('stage'), undefined);
    assert.equal(harness.attempts.rows.length, 2);
  });

  it('ignores an attempt on another daemon', async () => {
    const { harness, row } = await setup();
    await harness.orchestrator.startDeploy(row('stage'), undefined);
    harness.runner.finish(0);
    await untilRunning(harness.profiles, 'stage');
    harness.daemon.id = 'daemon-2';

    await harness.orchestrator.startDeploy(row('stage'), undefined);
    assert.equal(harness.attempts.rows.length, 2);
  });
});

describe('what boot does with the attempts a gone manager left open', () => {
  it('releases one whose every touched service shows a new container, and blocks the rest', async () => {
    const { harness, row, recreated } = await setup();
    await harness.orchestrator.startDeploy(row('stage'), undefined);
    await harness.orchestrator.startDeploy(row('other'), undefined).catch(() => undefined);
    // The manager died with the attempt open. The next one observes.
    recreated('stage');

    const outcome = await harness.orchestrator.reconcileAttempts();

    assert.deepEqual(outcome, { released: ['stage'], blocked: [] });
    assert.equal(harness.attempts.rows[0]?.state, 'released');
  });

  it('blocks one whose containers show nothing new, and says so', async () => {
    const { harness, row } = await setup();
    await harness.orchestrator.startDeploy(row('stage'), undefined);

    const outcome = await harness.orchestrator.reconcileAttempts();

    assert.deepEqual(outcome, { released: [], blocked: ['stage'] });
    assert.match(harness.attempts.rows[0]?.reason ?? '', /srs, stream-uploader, bee-uploader|never seen/);
  });
});

describe('what the pages are told', () => {
  it('says attempt.changed when an attempt opens and again when it is judged', async () => {
    const { harness, row, recreated } = await setup();
    const told: string[] = [];
    harness.events.subscribe((event) => told.push(event.type));

    await harness.orchestrator.startDeploy(row('stage'), undefined);
    assert.equal(told.filter((type) => type === 'attempt.changed').length, 1, 'once for the opening');

    recreated('stage');
    harness.runner.finish(0);
    await untilRunning(harness.profiles, 'stage');
    assert.equal(told.filter((type) => type === 'attempt.changed').length, 2, 'and once for the judgement');
  });

  it('says attempt.changed when a person releases one, and nothing about versions', async () => {
    const { harness, row } = await setup();
    await harness.orchestrator.startDeploy(row('stage'), undefined);
    harness.runner.finish(0);
    await untilRunning(harness.profiles, 'stage');
    const told: string[] = [];
    harness.events.subscribe((event) => told.push(event.type));

    await harness.orchestrator.releaseAttempt(harness.attempts.rows[0]!.id, 'levi');

    assert.deepEqual(told, ['attempt.changed']);
  });
});
