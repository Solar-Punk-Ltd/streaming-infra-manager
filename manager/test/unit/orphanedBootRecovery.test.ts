/**
 * What boot makes of a deployment the manager was interrupted in the middle of.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * A deploy takes minutes, so a restart inside one is ordinary. Boot judges each
 * row it finds in DEPLOYING, STOPPING or REMOVING by whether that deployment's
 * services are running now, and a service is running when at least one of its
 * containers is. Nothing later repairs a wrong answer: the containers a page
 * shows are written from the environment the manager computed, never compared
 * with the daemon, so the status boot writes stands until somebody deploys
 * again.
 *
 * Two earlier readings were both wrong in that lasting way. Boot first wrote
 * ERROR over every such row without asking Docker anything, which reported a
 * stack compose had already brought up as a failed deployment while it was
 * streaming. It then asked for container ids alone, which counted a container
 * that had exited or was crash looping exactly like one that was up.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { throwawayRoot } from '../support/throwawayRoot.js';

const root = throwawayRoot('orphaned-boot-recovery-');
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');

const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');

/** The harness gives every default service of a stored profile a container. */
const interrupted = (status: 'DEPLOYING' | 'STOPPING' | 'REMOVING') =>
  orchestratorHarness([
    makeProfile({ name: 'stage', components: ['srs', 'stream-uploader'], status, last_error: null }),
  ]);

describe('a deployment the manager restarted under', () => {
  it('is RUNNING again when every service it expects has a container', async () => {
    const h = interrupted('DEPLOYING');

    await h.orchestrator.reconcileOrphanedTransitions();

    const row = h.profiles.rows.get('stage')!;
    assert.equal(row.status, 'RUNNING');
    assert.equal(row.last_error, null);
  });

  it('is ERROR naming the service that has no container', async () => {
    const h = interrupted('DEPLOYING');
    h.daemon.set('stage', 'stream-uploader', []);

    await h.orchestrator.reconcileOrphanedTransitions();

    const row = h.profiles.rows.get('stage')!;
    assert.equal(row.status, 'ERROR');
    assert.match(row.last_error ?? '', /stream-uploader/);
    assert.match(row.last_error ?? '', /restarted/i);
  });

  it('is STOPPED when it was stopping and its containers are gone', async () => {
    const h = interrupted('STOPPING');
    for (const service of ['srs', 'stream-uploader']) h.daemon.set('stage', service, []);

    await h.orchestrator.reconcileOrphanedTransitions();

    const row = h.profiles.rows.get('stage')!;
    assert.equal(row.status, 'STOPPED');
    assert.equal(row.last_error, null);
  });

  it('keeps the older rule when the daemon does not answer, and says so', async () => {
    const h = interrupted('DEPLOYING');
    h.daemon.snapshot = () => Promise.reject(new Error('synthetic daemon refusal'));

    await h.orchestrator.reconcileOrphanedTransitions();

    const row = h.profiles.rows.get('stage')!;
    assert.equal(row.status, 'ERROR');
    assert.match(row.last_error ?? '', /restarted/i);
    assert.match(row.last_error ?? '', /did not answer/i);
  });

  /**
   * A removal that never got started leaves everything running, and that is
   * what the deployment then is. Levi accepted this on 2026-09-16: the row is
   * back where an operator can act on it, and pressing Remove again is one
   * click. The alternative, keeping REMOVING, is the transitional state that
   * refuses every later action as busy.
   */
  it('is RUNNING again when a removal was interrupted before it removed anything', async () => {
    const h = interrupted('REMOVING');

    await h.orchestrator.reconcileOrphanedTransitions();

    assert.equal(h.profiles.rows.get('stage')!.status, 'RUNNING');
  });

  it('is ERROR naming the service whose container has exited, and not the one that is up', async () => {
    const h = interrupted('DEPLOYING');
    h.daemon.set('stage', 'srs', ['stage-srs-0'], 'exited');

    await h.orchestrator.reconcileOrphanedTransitions();

    const row = h.profiles.rows.get('stage')!;
    assert.equal(row.status, 'ERROR');
    assert.match(row.last_error ?? '', /srs/);
    assert.match(row.last_error ?? '', /exited/);
    assert.doesNotMatch(row.last_error ?? '', /stream-uploader/);
  });

  it('is ERROR naming a service that is crash looping, in the word Docker uses for it', async () => {
    const h = interrupted('DEPLOYING');
    h.daemon.set('stage', 'srs', ['stage-srs-0'], 'restarting');

    await h.orchestrator.reconcileOrphanedTransitions();

    const row = h.profiles.rows.get('stage')!;
    assert.equal(row.status, 'ERROR');
    assert.match(row.last_error ?? '', /srs/);
    assert.match(row.last_error ?? '', /restarting/);
  });

  /** A finished `docker compose stop` leaves the containers there and exited. */
  it('is STOPPED when it was stopping and every container has exited', async () => {
    const h = interrupted('STOPPING');
    for (const service of ['srs', 'stream-uploader']) {
      h.daemon.set('stage', service, [`stage-${service}-0`], 'exited');
    }

    await h.orchestrator.reconcileOrphanedTransitions();

    const row = h.profiles.rows.get('stage')!;
    assert.equal(row.status, 'STOPPED');
    assert.equal(row.last_error, null);
  });

  it('is ERROR naming what a half finished stop left running', async () => {
    const h = interrupted('STOPPING');
    h.daemon.set('stage', 'stream-uploader', ['stage-stream-uploader-0'], 'exited');

    await h.orchestrator.reconcileOrphanedTransitions();

    const row = h.profiles.rows.get('stage')!;
    assert.equal(row.status, 'ERROR');
    assert.match(row.last_error ?? '', /srs/);
  });

  it('leaves a settled deployment alone', async () => {
    const h = orchestratorHarness([makeProfile({ name: 'stage', status: 'STOPPED' })]);

    const settled = await h.orchestrator.reconcileOrphanedTransitions();

    assert.deepEqual(settled, []);
    assert.equal(h.profiles.statusOf('stage'), 'STOPPED');
  });
});
