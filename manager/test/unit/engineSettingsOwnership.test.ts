/**
 * A settings save claims the deployment before it stores anything.
 *
 * Unit test, no database and no deploy script. `pnpm test` in manager/.
 *
 * Two saves can both pass the busy check. Without the claim both stored, both
 * wrote the env file, and the one refused the recreate marked the profile ERROR
 * under the other one's running job.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProfileBusyError } from '../../src/domain/errors/index.js';
import {
  profileRow,
  profileServiceHarness,
} from '../support/profileServiceHarness.js';

describe('updateEngineSettings and the claim', () => {
  it('stores nothing when the deployment is claimed by someone else', async () => {
    const harness = profileServiceHarness([profileRow()]);
    harness.profiles.claimsRefused.add('stream1');

    await assert.rejects(
      harness.service.updateEngineSettings('stream1', { HLS_FRAGMENT: '2' }),
      ProfileBusyError,
    );

    assert.deepEqual(harness.profiles.rows.get('stream1')?.engine_settings, {});
    assert.equal(harness.profiles.statusOf('stream1'), 'RUNNING');
    assert.deepEqual(harness.orchestrator.deploys, []);
    assert.deepEqual(harness.profiles.markErrorCalls, []);
  });

  it('marks the profile ERROR once when the recreate fails after the claim', async () => {
    const harness = profileServiceHarness([profileRow()]);
    harness.orchestrator.failingDeploys.add('stream1');

    await assert.rejects(
      harness.service.updateEngineSettings('stream1', { HLS_FRAGMENT: '2' }),
    );

    assert.deepEqual(harness.profiles.rows.get('stream1')?.engine_settings, {
      HLS_FRAGMENT: '2',
    });
    assert.equal(harness.profiles.statusOf('stream1'), 'ERROR');
    assert.deepEqual(harness.profiles.markErrorCalls, ['stream1']);
  });

  it('claims, stores and recreates the engine in that order', async () => {
    const harness = profileServiceHarness([profileRow()]);

    await harness.service.updateEngineSettings('stream1', { HLS_FRAGMENT: '2' });

    assert.deepEqual(harness.orchestrator.reserved, ['stream1']);
    assert.deepEqual(harness.orchestrator.deploys, [
      { profileName: 'stream1', services: ['srs'] },
    ]);
  });
});
