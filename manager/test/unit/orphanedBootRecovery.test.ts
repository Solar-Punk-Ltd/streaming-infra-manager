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

  it('leaves a settled deployment alone', async () => {
    const h = orchestratorHarness([makeProfile({ name: 'stage', status: 'STOPPED' })]);

    const settled = await h.orchestrator.reconcileOrphanedTransitions();

    assert.deepEqual(settled, []);
    assert.equal(h.profiles.statusOf('stage'), 'STOPPED');
  });
});
