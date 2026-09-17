/**
 * When `.env.<profile>` is written, relative to owning the deployment.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * The env file is the deployment's configuration: STAMP, BEE_PUBLISHERS,
 * SRT_PASSPHRASE and the engine all reach the containers through it, and there
 * is one file per profile shared by every caller. Writing it before the profile
 * has been claimed lets a caller that is about to be refused hand its settings
 * to somebody else's running deploy.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ProfileBusyError } from '../../src/domain/errors/index.js';
import { throwawayRoot } from '../support/throwawayRoot.js';
import { makeProfile } from '../support/profileFixtures.js';

// SUBMODULE is resolved when envUtils loads, so the scratch root has to be set
// before the harness is imported, hence the dynamic import below.
const root = throwawayRoot('deploy-reservation-');
process.env.SHLS_ROOT = root;

const { orchestratorHarness } = await import(
  '../support/orchestratorHarness.js'
);
const { writeProfileEnv } = await import('../../src/utils/envUtils.js');

const STAGE = 'stage';
const envPath = join(root, `.env.${STAGE}`);

function withBaseEnv(): void {
  writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');
}

describe('the env file and the deploy claim', () => {
  it('writes it and starts the script once the profile is claimed', async () => {
    withBaseEnv();
    const stored = makeProfile({ name: STAGE, stamp_id: 'a'.repeat(64) });
    const { orchestrator, profiles, runner } = orchestratorHarness([stored]);

    await orchestrator.startDeploy(stored, undefined);

    assert.ok(existsSync(envPath), 'the profile env file should be written');
    assert.match(readFileSync(envPath, 'utf8'), /^STAMP=a{64}$/m);
    assert.equal(runner.runs.length, 1);
    // Still claimed: the script is running and nothing has released it.
    assert.equal(profiles.statusOf(STAGE), 'DEPLOYING');
  });

  it('leaves it untouched when the claim is refused', async () => {
    withBaseEnv();
    const running = 'STAMP=' + 'a'.repeat(64) + '\n';
    writeFileSync(envPath, running, 'utf8');

    // The caller read the profile while it was RUNNING. By the time it
    // deploys, another caller owns it. The stale copy is what the caller
    // still holds, and it carries settings that must not reach the running
    // deploy.
    const stale = makeProfile({ name: STAGE, stamp_id: 'b'.repeat(64) });
    const { orchestrator, profiles, runner } = orchestratorHarness([
      { ...stale, status: 'DEPLOYING' },
    ]);

    await assert.rejects(
      orchestrator.startDeploy(stale, undefined),
      ProfileBusyError,
    );

    assert.equal(
      readFileSync(envPath, 'utf8'),
      running,
      'a refused caller must not rewrite the running deploy config',
    );
    assert.equal(runner.runs.length, 0);
    assert.deepEqual(profiles.markErrorCalls, []);
  });
});

/**
 * What T27 changed for a deployment that chose nothing.
 *
 * Every row the migration touched reads as mode null and source `stack`, which
 * is what the stack already did, so the file a deploy writes for such a row has
 * to be the file it wrote before any of this existed. Driven through the
 * orchestrator's own call rather than through hand-built values, because the
 * call is what changed.
 */
describe('the env file of a deployment made before T27', () => {
  const baseEnv = 'ENGINE=srs\nRPC_ENDPOINT=https://rpc.gnosischain.com\n';

  /** The same call with the fields T27 added left out, which is how it read before. */
  const asItWasBefore = (profile: ReturnType<typeof makeProfile>): string =>
    readFileSync(
      writeProfileEnv(root, 'reference', {
        engine: 'srs',
        stampId: profile.stamp_id,
        beePublishers: profile.bee_publishers,
        beeUrl: profile.bee_url,
        rpcEndpoint: profile.rpc_endpoint,
        engineSettings: profile.engine_settings,
        localBeeUploader: true,
      }),
      'utf8',
    );

  async function deployed(profile: ReturnType<typeof makeProfile>): Promise<string> {
    writeFileSync(join(root, '.env'), baseEnv, 'utf8');
    const { orchestrator } = orchestratorHarness([profile]);
    await orchestrator.startDeploy(profile, undefined);
    return readFileSync(join(root, `.env.${profile.name}`), 'utf8');
  }

  it('is what it was for a row that names neither a mode nor an endpoint', async () => {
    const stored = makeProfile({ name: 'before-plain', stamp_id: 'a'.repeat(64) });

    const written = await deployed(stored);

    assert.equal(written, asItWasBefore(stored));
    assert.equal(
      written.includes('BEE_GATEWAY_'),
      false,
      'a deployment with no gateway gets none of the gateway keys',
    );
  });

  it('is what it was for a row that named an endpoint of its own', async () => {
    const stored = makeProfile({
      name: 'before-custom',
      stamp_id: 'a'.repeat(64),
      rpc_endpoint: 'http://host.docker.internal:9000',
      rpc_endpoint_source: 'custom',
    });

    assert.equal(await deployed(stored), asItWasBefore(stored));
  });
});
