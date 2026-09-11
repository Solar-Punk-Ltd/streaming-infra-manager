import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { throwawayRoot } from '../support/throwawayRoot.js';
import type { DeployReservation } from '../../src/domain/DeploymentOrchestrator.js';
import { ProfileConfigError } from '../../src/domain/errors/index.js';

const root = throwawayRoot('t04a-missing-version-');
process.env.SHLS_ROOT = join(root, 'bundled');
process.env.BEE_DATA_ROOT = join(root, 'data');
mkdirSync(process.env.SHLS_ROOT, { recursive: true });
writeFileSync(join(process.env.SHLS_ROOT, '.env'), 'ENGINE=srs\n');
after(() => rmSync(root, { recursive: true, force: true }));

const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');
let nextName = 0;

function setup(initial = false) {
  const profile = makeProfile({
    name: `test-${++nextName}`,
    stack_version_id: 404,
    status: initial ? 'DEPLOYING' : 'RUNNING',
    components: ['srs'],
    stamp_id: 'a'.repeat(64),
  });
  return { profile, ...orchestratorHarness([profile]) };
}

function missingVersion(err: unknown): boolean {
  return err instanceof ProfileConfigError && /404/.test(err.reason) && /no longer exists|missing/.test(err.reason);
}

describe('a missing stack version is not the bundled version', () => {
  for (const action of ['reserveDeploy', 'startDeploy', 'startDeployUploader', 'startInitialDeploy'] as const) {
    it(`${action} refuses the missing row before a reference or script starts`, async () => {
      const h = setup(action === 'startInitialDeploy');
      const before = structuredClone(h.profile);
      const call = action === 'startDeployUploader'
        ? h.orchestrator.startDeployUploader(h.profile)
        : h.orchestrator[action](h.profile, ['srs']);
      await assert.rejects(call, missingVersion);
      if (action === 'startInitialDeploy') {
        assert.equal(h.profiles.rows.get(h.profile.name)?.status, 'ERROR');
        assert.match(h.profiles.rows.get(h.profile.name)?.last_error ?? '', /404/);
      } else {
        assert.deepEqual(h.profiles.rows.get(h.profile.name), before);
      }
      assert.deepEqual(h.ledger.references, []);
      assert.equal(h.runner.runs.length, 0);
      assert.equal(existsSync(join(process.env.SHLS_ROOT!, `.env.${h.profile.name}`)), false);
    });
  }

  for (const descriptor of ['absent', 'null version'] as const) {
    for (const services of [[], ['srs']]) {
      it(`refuses runReserved with ${descriptor} and ${services.length} services`, async () => {
        const h = setup(true);
        const reservation: DeployReservation = {
          profileName: h.profile.name,
          services,
          heldBackForStamp: [],
          previousStatus: 'RUNNING',
          transitioned: true,
          build: descriptor === 'absent' ? null : {
            version: null,
            root: process.env.SHLS_ROOT!,
            buildId: 'bundled',
            referenceId: null,
          },
        };
        await assert.rejects(h.orchestrator.runReserved(reservation, h.profile), missingVersion);
        assert.equal(h.profiles.rows.get(h.profile.name)?.status, 'ERROR');
        assert.deepEqual(h.ledger.references, []);
        assert.equal(h.runner.runs.length, 0);
        assert.equal(existsSync(join(process.env.SHLS_ROOT!, `.env.${h.profile.name}`)), false);
      });
    }
  }

  it('still deploys a legitimate bundled legacy row with a null root', async () => {
    const h = setup();
    h.profile.stack_version_id = 1;
    await h.orchestrator.startDeploy(h.profile, ['srs']);
    assert.equal(h.runner.runs.length, 1);
    assert.equal(h.runner.runs[0]?.options.cwd, process.env.SHLS_ROOT);
    assert.equal(h.ledger.references[0]?.versionId, 1);
  });

  for (const action of ['startStop', 'startRemove', 'startHealth'] as const) {
    it(`preserves ${action} recovery for a profile whose version row is missing`, async () => {
      const h = setup();
      if (action === 'startStop') await h.orchestrator.startStop(h.profile, undefined);
      else await h.orchestrator[action](h.profile);
      assert.equal(h.runner.runs.length, 1);
      assert.equal(h.runner.runs[0]?.options.cwd, process.env.SHLS_ROOT);
      assert.doesNotMatch(h.runner.runs[0]?.script ?? '', /\/deploy\.sh$/);
    });
  }
});
