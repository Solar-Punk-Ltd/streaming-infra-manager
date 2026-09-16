/**
 * A deploy that fails ends the deployment's DEPLOYING, whatever moved under it.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * The write a failed deploy makes names every column its claim captured, so a
 * config file rollout or an operator action that moves the row while the script
 * runs makes it match nothing. Nothing else writes a status for that job, so
 * the row sat in DEPLOYING for good and every later action on the deployment
 * was refused as busy. The row is now ended on its status and its own claim's
 * instance, and the tuple that did not match is logged. A row another claim
 * owns is left alone: that claim's own outcome ends it.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { throwawayRoot } from '../support/throwawayRoot.js';

const root = throwawayRoot('deploy-failure-fallback-');
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');

const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');

async function until(what: string, ready: () => boolean): Promise<void> {
  for (let tick = 0; tick < 300; tick += 1) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('a deploy that fails after the row moved under it', () => {
  it('leaves the deployment ERROR rather than DEPLOYING', async () => {
    const h = orchestratorHarness([makeProfile({ name: 'stage', components: ['srs'] })]);
    await h.orchestrator.startDeploy(h.profiles.rows.get('stage')!, ['srs']);
    assert.equal(h.profiles.statusOf('stage'), 'DEPLOYING');

    await h.profiles.bumpIntent('stage');
    h.runner.finish(0, 1);

    await until('the failed deploy to leave DEPLOYING', () => h.profiles.statusOf('stage') !== 'DEPLOYING');
    assert.equal(h.profiles.statusOf('stage'), 'ERROR');
    assert.match(h.profiles.rows.get('stage')?.last_error ?? '', /exited with code 1/);
  });

  it('writes nothing over a row another claim owns, even while it is DEPLOYING', async () => {
    const h = orchestratorHarness([makeProfile({ name: 'stage', components: ['srs'] })]);
    await h.orchestrator.startDeploy(h.profiles.rows.get('stage')!, ['srs']);
    assert.equal(h.profiles.statusOf('stage'), 'DEPLOYING');

    h.profiles.write('stage', { instance_id: 'a-newer-claim' });
    h.runner.finish(0, 1);

    await until('the failure to be handled', () => h.runner.runs.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.profiles.statusOf('stage'), 'DEPLOYING');
    assert.equal(h.profiles.rows.get('stage')?.last_error ?? null, null);
  });

  it('writes nothing over a deployment that has already left DEPLOYING', async () => {
    const h = orchestratorHarness([makeProfile({ name: 'stage', components: ['srs'] })]);
    await h.orchestrator.startDeploy(h.profiles.rows.get('stage')!, ['srs']);

    h.profiles.write('stage', { status: 'REMOVING', intent_revision: 9 });
    h.runner.finish(0, 1);

    await until('the failure to be handled', () => h.runner.runs.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.profiles.statusOf('stage'), 'REMOVING');
  });
});
