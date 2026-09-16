/**
 * What a run that was killed rather than finished tells the operator.
 *
 * Unit test, no database and no Docker, but the first case spawns a real
 * process. `pnpm test` in manager/.
 *
 * A child ended by a signal has no exit code at all, and the runner reported it
 * as code -1 and dropped the signal. The reason recorded against the deployment
 * was then the last four kilobytes of whatever the script had printed before it
 * was killed, which reads as though that output were the failure.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ScriptRunner, type RunOutcome } from '../../src/domain/ScriptRunner.js';
import { throwawayRoot } from '../support/throwawayRoot.js';

const root = throwawayRoot('killed-run-');
process.env.SHLS_ROOT = root;
process.env.BEE_DATA_ROOT = join(root, 'data');
writeFileSync(join(root, '.env'), 'ENGINE=srs\n', 'utf8');

// exec, so the signal reaches the sleep itself: bash defers a SIGTERM until the
// command it is waiting on has finished, and there would be nothing to see for
// thirty seconds.
const SLEEPER = join(root, 'sleeper.sh');
writeFileSync(SLEEPER, 'exec sleep 30\n', 'utf8');

const { makeProfile } = await import('../support/profileFixtures.js');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');

async function until(what: string, ready: () => boolean): Promise<void> {
  for (let tick = 0; tick < 300; tick += 1) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('a run that was killed', () => {
  it('ends with the signal that ended it', async () => {
    const handle = new ScriptRunner().run(SLEEPER, []);
    const ended = new Promise<RunOutcome>((resolve) => handle.emitter.once('done', resolve));

    handle.kill();

    assert.deepEqual(await ended, { code: -1, signal: 'SIGTERM' });
  });

  it('is recorded against the deployment as a kill, not as its last output', async () => {
    const h = orchestratorHarness([makeProfile({ name: 'stage', components: ['srs'] })]);
    await h.orchestrator.startDeploy(h.profiles.rows.get('stage')!, ['srs']);

    h.runner.finish(0, -1, 'SIGKILL');

    await until('the killed deploy to be recorded', () => h.profiles.statusOf('stage') === 'ERROR');
    assert.match(h.profiles.rows.get('stage')?.last_error ?? '', /killed by SIGKILL/);
  });
});
