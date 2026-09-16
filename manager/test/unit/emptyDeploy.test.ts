/**
 * A deploy that has nothing to start says so instead of claiming RUNNING.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * Two deployments resolve to an empty service list: a custom one with no
 * components chosen, and one whose only service is the stream-uploader held
 * back for want of a usable postage stamp. Both used to end the deploy by
 * marking the row RUNNING with its last error cleared, over containers that
 * were never created, and the second gave the operator no reason at all.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { StampRequiredError } from '../../src/domain/errors/index.js';
import { throwawayRoot } from '../support/throwawayRoot.js';

const root = throwawayRoot('empty-deploy-');
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');

const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');

describe('a deploy with no service to run', () => {
  for (const status of ['STOPPED', 'ERROR'] as const) {
    it(`leaves a components-less custom deployment ${status}, as it was`, async () => {
      const h = orchestratorHarness([
        makeProfile({ name: 'stage', kind: 'custom', components: [], status }),
      ]);

      await h.orchestrator.startDeploy(h.profiles.rows.get('stage')!, undefined);

      assert.equal(h.profiles.statusOf('stage'), status);
      assert.deepEqual(h.runner.runs, [], 'nothing was started, so nothing may be reported as started');
    });
  }

  it('says why a deployment that goes back to ERROR is still there', async () => {
    const h = orchestratorHarness([
      makeProfile({ name: 'stage', kind: 'custom', components: [], status: 'ERROR' }),
    ]);

    await h.orchestrator.startDeploy(h.profiles.rows.get('stage')!, undefined);

    assert.match(h.profiles.rows.get('stage')?.last_error ?? '', /no service to deploy/);
  });

  it('refuses a deploy of the uploader alone while it waits for a stamp', async () => {
    const h = orchestratorHarness([
      makeProfile({ name: 'stage', stamp_id: null, bee_publishers: null }),
    ]);

    await assert.rejects(
      h.orchestrator.startDeploy(h.profiles.rows.get('stage')!, ['stream-uploader']),
      StampRequiredError,
    );

    assert.equal(h.profiles.statusOf('stage'), 'ERROR');
    assert.match(h.profiles.rows.get('stage')?.last_error ?? '', /postage stamp/);
  });
});
