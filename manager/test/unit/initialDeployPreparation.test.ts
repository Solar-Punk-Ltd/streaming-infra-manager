import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ProfileConfigError } from '../../src/domain/errors/index.js';
import { readStackContract } from '../../src/domain/versions/stackContract.js';
import { throwawayRoot } from '../support/throwawayRoot.js';
import { V3_FIXTURE } from '../support/stackFixtures.js';

const root = throwawayRoot('t04a-initial-preparation-');
process.env.SHLS_ROOT = join(root, 'bundled');
process.env.BEE_DATA_ROOT = join(root, 'data');
mkdirSync(process.env.SHLS_ROOT, { recursive: true });
writeFileSync(join(process.env.SHLS_ROOT, '.env'), 'ENGINE=srs\n');
after(() => rmSync(root, { recursive: true, force: true }));

const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');

describe('initial deployment preparation failure', () => {
  for (const failure of ['version read', 'artifact check', 'locked description'] as const) {
    it(`marks the inserted profile ERROR when ${failure} fails before runReserved`, async () => {
      const profile = makeProfile({ status: 'DEPLOYING', components: ['srs'] });
      const h = orchestratorHarness([profile]);
      const errors: string[] = [];
      h.events.subscribe(event => {
        if (event.type === 'profile.changed' && event.profile.status === 'ERROR') errors.push(event.profile.last_error ?? '');
      });
      let expected = /preparation failed/;
      if (failure === 'version read') {
        h.versions.findById = async () => { throw new Error('version preparation failed'); };
      } else if (failure === 'artifact check') {
        const version = await h.versions.insert({ name: 'missing-build', gitRef: 'test', rootPath: join(root, 'missing') });
        await h.versions.publish(version.id, { buildId: 'a'.repeat(40), commitSha: 'a'.repeat(40), contract: readStackContract(V3_FIXTURE) });
        profile.stack_version_id = version.id;
        expected = /cannot be deployed from/;
      } else {
        h.ledger.describe = async () => { throw new ProfileConfigError(profile.name, 'snapshot preparation failed'); };
      }

      await assert.rejects(h.orchestrator.startInitialDeploy(profile, ['srs']), expected);

      const stored = h.profiles.rows.get(profile.name)!;
      assert.equal(stored.status, 'ERROR');
      assert.match(stored.last_error ?? '', expected);
      assert.ok(stored.last_error_at);
      assert.equal(errors.length, 1);
      assert.match(errors[0]!, expected);
      assert.deepEqual(h.profiles.markErrorCalls, [profile.name]);
      assert.deepEqual(h.ledger.references, []);
      assert.equal(h.runner.runs.length, 0);
    });
  }

  it('records a later runReserved failure once without replacing its reason', async () => {
    const profile = makeProfile({ status: 'DEPLOYING', components: ['srs'] });
    const h = orchestratorHarness([profile]);
    h.runner.run = () => { throw new Error('runner refused'); };
    await assert.rejects(h.orchestrator.startInitialDeploy(profile, ['srs']), /runner refused/);
    assert.deepEqual(h.profiles.markErrorCalls, [profile.name]);
    assert.equal(h.profiles.rows.get(profile.name)?.last_error, 'runner refused');
  });
});
