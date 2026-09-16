/**
 * What boot makes of a deployment the manager was interrupted in the middle of.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * A deploy takes minutes, so a restart inside one is ordinary. Boot used to
 * write ERROR over every row it found in DEPLOYING, STOPPING or REMOVING
 * without asking Docker anything, so a stack compose had already brought up
 * was reported as a failed deployment while it was streaming. Nothing later
 * repairs that: the containers a page shows are written from the environment
 * the manager computed, never compared with the daemon, so the wrong status
 * stands until somebody deploys again.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { DaemonSnapshot } from '../../src/domain/DeployAttemptRepository.js';
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

  /**
   * A recorded limit, not a behaviour anybody wants.
   *
   * The snapshot this judgement reads carries container ids and nothing else,
   * so a service whose container has exited is counted exactly like one that
   * is up, and a deployment crash looping after a restart reads as RUNNING
   * with nothing to say otherwise. Closing it means the snapshot carrying each
   * container's state: `DaemonSnapshot` in DeployAttemptRepository.ts, both
   * readers in ports/TargetDocker.ts, which have the state in hand today and
   * drop it, and `attemptOutcome`, which the deploy path judges with and which
   * assert-started.sh already covers.
   *
   * The assignment below is the tripwire. It stops compiling the day a
   * snapshot says more than an id, so the judgement is revisited then rather
   * than left as it is.
   */
  it('judges from container ids alone, whatever state those containers are in', async () => {
    const h = interrupted('DEPLOYING');
    const idsAlone: (snapshot: DaemonSnapshot) => Map<string, string[]> = (snapshot) => snapshot.containers;

    const seen = idsAlone(await h.daemon.snapshot('stage'));

    assert.deepEqual([...seen.keys()].sort(), ['srs', 'stream-uploader']);
    assert.deepEqual(seen.get('stream-uploader'), ['stage-stream-uploader-0']);
  });

  it('leaves a settled deployment alone', async () => {
    const h = orchestratorHarness([makeProfile({ name: 'stage', status: 'STOPPED' })]);

    const settled = await h.orchestrator.reconcileOrphanedTransitions();

    assert.deepEqual(settled, []);
    assert.equal(h.profiles.statusOf('stage'), 'STOPPED');
  });
});
