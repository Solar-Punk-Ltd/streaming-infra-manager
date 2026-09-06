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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ProfileBusyError } from '../../src/domain/errors/index.js';
import { makeProfile } from '../support/profileFixtures.js';

// SUBMODULE is resolved when envUtils loads, so the scratch root has to be set
// before the harness is imported, hence the dynamic import below.
const root = mkdtempSync(join(tmpdir(), 'deploy-reservation-'));
process.env.SHLS_ROOT = root;

const { orchestratorHarness } = await import(
  '../support/orchestratorHarness.js'
);

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
