/**
 * Which build a deploy runs, decided once, at the claim, and never reread.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * A deploy used to reread its version inside the job, so a deploy admitted
 * on build A could start on B once an update published it, and nothing
 * durable said which build a running container was started from. Now the
 * claim captures the build with a job reference, the job runs on what was
 * captured, and the success hook records what the containers were seen to
 * mount, which is what resolves the job's reference.
 */
import assert from 'node:assert/strict';
import { throwawayRoot } from '../support/throwawayRoot.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { StackContract } from '@streaming-infra-manager/common';

import { ProfileBusyError, ProfileConfigError } from '../../src/domain/errors/index.js';
import {
  BUILD_COMPLETE_MARKER,
  BUILD_MANIFEST_FILE,
} from '../../src/domain/versions/buildManifest.js';
import { portPlanFor } from '../../src/domain/ports/portReservations.js';

const root = throwawayRoot('deploy-descriptor-');
process.env.SHLS_ROOT = join(root, 'bundled');
process.env.BEE_DATA_ROOT = join(root, 'data');
mkdirSync(join(root, 'bundled'), { recursive: true });
writeFileSync(join(root, 'bundled', '.env'), 'ENGINE=srs\n');

const { buildDirFor } = await import('../../src/domain/versions/stackPaths.js');
const { BUNDLED_STACK_ROOT } = await import('../../src/utils/envUtils.js');
const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness, untilRunning } = await import('../support/orchestratorHarness.js');

const CONTRACT: StackContract = {
  ports: [...ALLOCATION_CONTRACT.ports],
  maxSlot: 99,
  requiredSecrets: [],
  engineDefaults: {},
  features: { srsApiPort: true, chequebookGate: false, sharedImageTags: true },
  chequebookMinBzz: null,
  engineConfig: { srs: true, ome: false },
  engineImages: { srs: 'ossrs/srs:6', ome: null },
  warnings: [],
  allocationProblem: null,
};

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);

/** A complete build of v3 on disk, with the sample the deploy bootstraps from. */
function buildOnDisk(versionsRoot: string, buildId: string, name = 'v3'): string {
  const dir = buildDirFor(versionsRoot, name, buildId);
  mkdirSync(join(dir, 'deploy', 'scripts'), { recursive: true });
  writeFileSync(join(dir, '.env'), 'ENGINE=srs\n');
  writeFileSync(join(dir, BUILD_MANIFEST_FILE), JSON.stringify({ commit: buildId.slice(0, 40), buildId, builtAt: new Date().toISOString(), toolchain: 't' }));
  writeFileSync(join(dir, BUILD_COMPLETE_MARKER), '');
  return dir;
}

/** Every test gets its own versions root, so what one puts on disk is not another's build. */
async function setup(buildId: string | null = COMMIT_A) {
  const versionsRoot = mkdtempSync(join(root, 'versions-'));
  const harness = orchestratorHarness(
    [makeProfile({ name: 'stage', stack_version_id: 2, stamp_id: 'a'.repeat(64) })],
    undefined,
    versionsRoot,
  );
  const v3 = await harness.versions.insert({ name: 'v3', gitRef: 'main-v3', rootPath: join(versionsRoot, 'v3') });
  if (buildId) {
    buildOnDisk(versionsRoot, buildId);
    await harness.versions.publish(v3.id, { buildId, commitSha: buildId.slice(0, 40), contract: CONTRACT });
  }
  const row = () => {
    const found = harness.profiles.rows.get('stage');
    if (!found) throw new Error('stage is gone');
    return found;
  };
  return { harness, v3, row, versionsRoot };
}

describe('the build a deploy runs', () => {
  it('is captured at the claim with a job reference, and the job runs on it whatever is published meanwhile', async () => {
    const { harness, v3, versionsRoot } = await setup();
    const buildA = buildDirFor(versionsRoot, 'v3', COMMIT_A);

    const reservation = await harness.orchestrator.reserveDeploy(harness.profiles.rows.get('stage')!, undefined);
    assert.equal(reservation.build?.root, buildA);
    assert.equal(reservation.build?.buildId, COMMIT_A);
    assert.deepEqual(harness.ledger.openJobReferences('stage').map((r) => [r.buildId, [...r.services]]), [[COMMIT_A, reservation.services]]);

    buildOnDisk(versionsRoot, COMMIT_B);
    await harness.versions.publish(v3.id, { buildId: COMMIT_B, commitSha: COMMIT_B, contract: CONTRACT });
    await harness.orchestrator.runReserved(reservation, harness.profiles.rows.get('stage')!);

    const run = harness.runner.runs[harness.runner.runs.length - 1];
    assert.equal(run?.options.cwd, buildA, 'the job ran on the build the claim captured');
    assert.match(run?.script ?? '', new RegExp(`^${buildA}/`));
  });

  it('refuses a builds row whose build is missing, naming it, and takes no claim', async () => {
    const { harness, row } = await setup(null);
    await harness.versions.publish(2, { buildId: COMMIT_B, commitSha: COMMIT_B, contract: CONTRACT });

    await assert.rejects(
      harness.orchestrator.reserveDeploy(row(), undefined),
      (err: unknown) => err instanceof ProfileConfigError && new RegExp(COMMIT_B).test(err.reason),
    );
    assert.equal(row().status, 'RUNNING');
    assert.deepEqual(harness.ledger.references, []);
  });

  it('still refuses a busy deployment, and writes no reference for it', async () => {
    const { harness, row } = await setup();
    harness.profiles.write('stage', { status: 'DEPLOYING' });

    await assert.rejects(harness.orchestrator.reserveDeploy(row(), undefined), ProfileBusyError);
    assert.deepEqual(harness.ledger.references, []);
  });

  it('runs a legacy row from its flat root, referenced as legacy', async () => {
    const { harness, v3, row, versionsRoot } = await setup(null);
    mkdirSync(join(versionsRoot, 'v3', 'deploy', 'scripts'), { recursive: true });
    writeFileSync(join(versionsRoot, 'v3', '.env'), 'ENGINE=srs\n');
    harness.versions.markLegacy(v3.id);
    await harness.versions.markBuilt(v3.id, { commitSha: COMMIT_A, contract: CONTRACT });

    const reservation = await harness.orchestrator.reserveDeploy(row(), undefined);

    assert.equal(reservation.build?.root, join(versionsRoot, 'v3'));
    assert.equal(reservation.build?.buildId, 'legacy');
    await harness.orchestrator.cancelReservation(reservation);
  });
});

describe('a deployment on the bundled version', () => {
  it('runs the legacy tree until the bundled version is published, and its build after, each by its own deploy', async () => {
    const { harness, versionsRoot } = await setup(null);
    harness.profiles.write('stage', { stack_version_id: 1 });
    const row = () => harness.profiles.rows.get('stage')!;

    await harness.orchestrator.startDeploy(row(), undefined);
    harness.runner.finish(0);
    await untilRunning(harness.profiles, 'stage');
    assert.equal(harness.runner.runs[0]?.options.cwd, BUNDLED_STACK_ROOT, 'the legacy tree, as before');

    // The manager's deploy published the bundled stack as a build. Nothing
    // moved the deployment, so what it runs is unchanged until the next deploy.
    buildOnDisk(versionsRoot, COMMIT_B, 'bundled');
    await harness.versions.publish(1, {
      buildId: COMMIT_B,
      commitSha: COMMIT_B,
      contract: CONTRACT,
      rootPath: join(versionsRoot, 'bundled'),
    });
    assert.equal(harness.ledger.openJobReferences('stage').length, 1, 'the deploy on the legacy tree keeps its reference');

    await harness.orchestrator.startDeploy(row(), undefined);
    harness.runner.finish(1, 0);
    await untilRunning(harness.profiles, 'stage');

    assert.equal(harness.runner.runs[1]?.options.cwd, buildDirFor(versionsRoot, 'bundled', COMMIT_B));
    const job = harness.ledger.references.filter((r) => r.holderKind === 'job' && r.holderId === 'stage');
    assert.deepEqual(job.map((r) => [r.versionId, r.buildId]), [[1, 'bundled'], [1, COMMIT_B]]);
  });

  it('refuses a missing version without taking a bundled reference or starting a script', async () => {
    const { harness } = await setup(null);
    harness.profiles.write('stage', { stack_version_id: 99 });
    const row = () => harness.profiles.rows.get('stage')!;

    await assert.rejects(harness.orchestrator.startDeploy(row(), undefined), /Stack version 99 no longer exists/);
    assert.equal(harness.runner.runs.length, 0);
    assert.deepEqual(harness.ledger.references, []);
  });
});

describe('what the success hook records', () => {
  it('resolves a bundled legacy job after observing its own checkout root', async () => {
    const h = orchestratorHarness([makeProfile({ name: 'bundled-stage', components: ['srs'] })]);
    h.ledger.mounted.set('bundled-stage/srs', process.env.SHLS_ROOT!);
    await h.orchestrator.startDeploy(h.profiles.rows.get('bundled-stage')!, ['srs']);
    h.runner.finish(0);
    await untilRunning(h.profiles, 'bundled-stage');
    assert.deepEqual(h.ledger.openJobReferences('bundled-stage'), []);
    assert.ok(h.ledger.references.some(reference => reference.holderId === 'bundled-stage/srs' && reference.versionId === 1));
  });

  it('hands over engine ports after the captured build is observed and preserves untouched uploader ports', async () => {
    const { harness, row, versionsRoot, v3 } = await setup();
    const old = portPlanFor(CONTRACT.ports, row().port_slot);
    await harness.profiles.reservations.plan(harness.daemon.id, 'stage', old, 'original');
    for (const service of ['srs', 'stream-uploader', 'bee-uploader']) {
      harness.ledger.mounted.set(`stage/${service}`, buildDirFor(versionsRoot, 'v3', COMMIT_A));
    }
    await harness.orchestrator.startDeploy(row(), undefined);
    harness.runner.finish(0);
    await untilRunning(harness.profiles, 'stage');
    const next = { ...CONTRACT, ports: CONTRACT.ports.map(port => port.service === 'srs'
      ? { ...port, slotBase: port.slotBase + 3000 } : port) };
    buildOnDisk(versionsRoot, COMMIT_B);
    await harness.versions.publish(v3.id, { buildId: COMMIT_B, commitSha: COMMIT_B, contract: next });
    harness.ledger.mounted.set('stage/srs', buildDirFor(versionsRoot, 'v3', COMMIT_B));
    harness.published.bindings = portPlanFor(next.ports, row().port_slot).map(port => ({ ...port, project: 'stage' }));
    await harness.orchestrator.startDeploy(row(), ['srs']);
    harness.runner.finish(1);
    await untilRunning(harness.profiles, 'stage');
    const held = await harness.profiles.reservations.listByProfile('stage');
    for (const port of old) {
      assert.equal(held.some(row => row.port === port.port && row.protocol === port.protocol), port.service !== 'srs');
    }
    assert.ok(held.some(port => port.service === 'srs' && port.state === 'active'));
  });

  it('observes what each service mounts, and resolves the job reference the observation covers', async () => {
    const { harness, row, versionsRoot } = await setup();
    const buildA = buildDirFor(versionsRoot, 'v3', COMMIT_A);
    harness.ledger.mounted.set('stage/srs', buildA);
    harness.ledger.mounted.set('stage/stream-uploader', buildA);
    harness.ledger.mounted.set('stage/bee-uploader', buildA);

    await harness.orchestrator.startDeploy(row(), undefined);
    harness.runner.finish(0);
    await untilRunning(harness.profiles, 'stage');

    assert.deepEqual(harness.ledger.openJobReferences('stage'), []);
    const snapshots = harness.ledger.references.filter((r) => r.holderKind === 'snapshot');
    assert.deepEqual(snapshots.map((r) => r.holderId).sort(), ['stage/bee-uploader', 'stage/srs', 'stage/stream-uploader']);
    assert.ok(snapshots.every((r) => r.buildId === COMMIT_A));
  });

  it('resolves the older snapshot of a service when a newer observation replaces it', async () => {
    const { harness, row, versionsRoot } = await setup();
    const buildA = buildDirFor(versionsRoot, 'v3', COMMIT_A);
    for (const service of ['srs', 'stream-uploader', 'bee-uploader']) harness.ledger.mounted.set(`stage/${service}`, buildA);

    await harness.orchestrator.startDeploy(row(), undefined);
    harness.runner.finish(0);
    await untilRunning(harness.profiles, 'stage');
    await harness.orchestrator.startDeploy(row(), undefined);
    harness.runner.finish(1, 0);
    await untilRunning(harness.profiles, 'stage');

    const srs = harness.ledger.references.filter((r) => r.holderId === 'stage/srs');
    assert.equal(srs.length, 2);
    assert.notEqual(srs[0]!.resolvedAt, null, 'the first snapshot is replaced');
    assert.equal(srs[1]!.resolvedAt, null, 'the newest snapshot stands');
  });

  it('keeps the job reference when the observation fails, and the deployment still comes up', async () => {
    const { harness, row } = await setup();
    harness.ledger.observeFailures.add('stage');

    await harness.orchestrator.startDeploy(row(), undefined);
    harness.runner.finish(0);
    await untilRunning(harness.profiles, 'stage');

    assert.equal(harness.ledger.openJobReferences('stage').length, 1);
    assert.equal(row().status, 'RUNNING');
  });

  it('brings the deployment up when recording what its containers run fails, and records no full deploy past it', async () => {
    const { harness, row, versionsRoot } = await setup();
    const buildA = buildDirFor(versionsRoot, 'v3', COMMIT_A);
    for (const service of ['srs', 'stream-uploader', 'bee-uploader']) harness.ledger.mounted.set(`stage/${service}`, buildA);
    harness.containers.failSetBuild = true;

    await harness.orchestrator.startDeploy(row(), undefined);
    harness.runner.finish(0);
    await untilRunning(harness.profiles, 'stage');

    assert.equal(row().status, 'RUNNING', 'the script exited 0 and the containers are up, whatever the row says');
    assert.equal(row().last_full_deploy_commit, null, 'nothing was recorded past the failure');
  });

  it('names the version whose build a container mounts, not the version of an earlier job', async () => {
    const { harness, row, versionsRoot } = await setup();
    const buildA = buildDirFor(versionsRoot, 'v3', COMMIT_A);
    for (const service of ['srs', 'stream-uploader', 'bee-uploader']) harness.ledger.mounted.set(`stage/${service}`, buildA);
    await harness.orchestrator.startDeploy(row(), undefined);
    harness.runner.finish(0);
    await untilRunning(harness.profiles, 'stage');

    const v4 = await harness.versions.insert({ name: 'v4', gitRef: 'main-v4', rootPath: join(versionsRoot, 'v4') });
    buildOnDisk(versionsRoot, COMMIT_B, 'v4');
    await harness.versions.publish(v4.id, { buildId: COMMIT_B, commitSha: COMMIT_B, contract: CONTRACT });
    harness.profiles.write('stage', { stack_version_id: v4.id });
    const buildB = buildDirFor(versionsRoot, 'v4', COMMIT_B);
    for (const service of ['srs', 'stream-uploader', 'bee-uploader']) harness.ledger.mounted.set(`stage/${service}`, buildB);
    await harness.orchestrator.startDeploy(row(), undefined);
    harness.runner.finish(1, 0);
    await untilRunning(harness.profiles, 'stage');

    const standing = harness.ledger.references.filter(
      (r) => r.holderKind === 'snapshot' && r.holderId === 'stage/srs' && r.resolvedAt === null,
    );
    assert.deepEqual(standing.map((r) => [r.versionId, r.buildId]), [[v4.id, COMMIT_B]]);
  });

  it('keeps the job reference when the script fails', async () => {
    const { harness, row } = await setup();

    await harness.orchestrator.startDeploy(row(), undefined);
    harness.runner.finish(0, 1);
    for (let tick = 0; tick < 200 && row().status !== 'ERROR'; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(row().status, 'ERROR');
    assert.equal(harness.ledger.openJobReferences('stage').length, 1);
  });

  it('leaves the uploader job open after an engine-only deploy whose observation saw only the engine', async () => {
    const { harness, row, versionsRoot } = await setup();
    const buildA = buildDirFor(versionsRoot, 'v3', COMMIT_A);
    harness.ledger.mounted.set('stage/srs', buildA);

    await harness.orchestrator.startDeploy(row(), undefined);
    harness.runner.finish(0);
    await untilRunning(harness.profiles, 'stage');

    const open = harness.ledger.openJobReferences('stage');
    assert.equal(open.length, 1, 'the uploader and the node were not seen');
    assert.ok(open[0]!.services.includes('stream-uploader'));
  });
});

describe('what the row says runs', () => {
  it('records each service\'s build and commit from observation, and the profile\'s last full deploy commit when every service agrees', async () => {
    const { harness, row, versionsRoot } = await setup();
    const buildA = buildDirFor(versionsRoot, 'v3', COMMIT_A);
    for (const service of ['srs', 'stream-uploader', 'bee-uploader']) harness.ledger.mounted.set(`stage/${service}`, buildA);

    await harness.orchestrator.startDeploy(row(), undefined);
    harness.runner.finish(0);
    await untilRunning(harness.profiles, 'stage');

    assert.deepEqual(
      [...harness.containers.builds.entries()].sort(),
      [
        ['stage/bee-uploader', { buildId: COMMIT_A, commit: COMMIT_A }],
        ['stage/srs', { buildId: COMMIT_A, commit: COMMIT_A }],
        ['stage/stream-uploader', { buildId: COMMIT_A, commit: COMMIT_A }],
      ],
    );
    assert.equal(row().last_full_deploy_commit, COMMIT_A);
  });

  it('does not advance untouched services or the full deploy commit on an engine-only deploy', async () => {
    const { harness, row, versionsRoot, v3 } = await setup();
    const buildA = buildDirFor(versionsRoot, 'v3', COMMIT_A);
    for (const service of ['srs', 'stream-uploader', 'bee-uploader']) harness.ledger.mounted.set(`stage/${service}`, buildA);
    await harness.orchestrator.startDeploy(row(), undefined);
    harness.runner.finish(0);
    await untilRunning(harness.profiles, 'stage');

    buildOnDisk(versionsRoot, COMMIT_B);
    await harness.versions.publish(v3.id, { buildId: COMMIT_B, commitSha: COMMIT_B, contract: CONTRACT });
    harness.ledger.mounted.set('stage/srs', buildDirFor(versionsRoot, 'v3', COMMIT_B));
    await harness.orchestrator.startDeploy(row(), ['srs']);
    harness.runner.finish(1, 0);
    await untilRunning(harness.profiles, 'stage');

    assert.deepEqual(harness.containers.builds.get('stage/srs'), { buildId: COMMIT_B, commit: COMMIT_B });
    assert.deepEqual(harness.containers.builds.get('stage/stream-uploader'), { buildId: COMMIT_A, commit: COMMIT_A });
    assert.equal(row().last_full_deploy_commit, COMMIT_A, 'a partial deploy is not a full one');
  });
});
