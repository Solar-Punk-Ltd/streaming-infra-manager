/**
 * Engine settings sent with a new group of deployments.
 *
 * Unit test, no database and no deploy script. `pnpm test` in manager/.
 *
 * A group's members are created in one transaction and are DEPLOYING the moment
 * it returns, so the create body is the only door a segment length has for all
 * of them at once, exactly as it is for a single deployment. The rule the single
 * create applies is applied here too, over the components the members actually
 * get, so a pool of Bee nodes is refused rather than storing keys no engine
 * there would ever read.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ABR_LADDER_SIZE } from '@streaming-infra-manager/common';

import { profileServiceHarness } from '../support/profileServiceHarness.js';

describe('engine settings on a new group', () => {
  it('gives every member what the create body carries', async () => {
    const harness = profileServiceHarness();

    await harness.service.createGroup({
      group_name: 'studio',
      size: 3,
      kind: 'streamer',
      engine_settings: { HLS_FRAGMENT: '2' },
    });

    assert.deepEqual(
      ['studio-profile-1', 'studio-profile-2', 'studio-profile-3'].map(
        (name) => harness.profiles.rows.get(name)?.engine_settings,
      ),
      [{ HLS_FRAGMENT: '2' }, { HLS_FRAGMENT: '2' }, { HLS_FRAGMENT: '2' }],
    );
  });

  it('leaves the column empty when the body says nothing, so the version default stands', async () => {
    const harness = profileServiceHarness();

    await harness.service.createGroup({
      group_name: 'studio',
      size: 1,
      kind: 'streamer',
    });

    assert.deepEqual(
      harness.profiles.rows.get('studio-profile-1')?.engine_settings,
      {},
    );
  });

  it('holds the group to the rule a single create applies, and stores nothing', async () => {
    // Four second pieces against the 2.5 second force-close ceiling compose
    // supplies when a deployment sets none, the same pair the single create
    // refuses. A group that got through here would deploy every member into
    // the same crash loop at once.
    const harness = profileServiceHarness();

    await assert.rejects(
      harness.service.createGroup({
        group_name: 'studio',
        size: 2,
        kind: 'streamer',
        engine_settings: { HLS_FRAGMENT: '4' },
      }),
      /2\.5 seconds is below the segment length of 4 seconds/,
    );
    assert.equal(harness.profiles.rows.has('studio-profile-1'), false);
  });

  it('refuses settings for a node pool, which runs no media server', async () => {
    const harness = profileServiceHarness();

    await assert.rejects(
      harness.service.createGroup({
        group_name: 'pool',
        size: ABR_LADDER_SIZE,
        kind: 'custom',
        abr_ladder: true,
        engine_settings: { HLS_FRAGMENT: '2' },
      }),
      /runs no media server/,
    );
  });

  it('creates a node pool as before when the body carries no settings', async () => {
    const harness = profileServiceHarness();

    const { profiles } = await harness.service.createGroup({
      group_name: 'pool',
      size: ABR_LADDER_SIZE,
      kind: 'custom',
      abr_ladder: true,
    });

    assert.equal(profiles.length, ABR_LADDER_SIZE);
    assert.deepEqual(profiles[0]!.engine_settings, {});
  });

  it('gives a member added later what its siblings were created with', async () => {
    const harness = profileServiceHarness();
    const { group } = await harness.service.createGroup({
      group_name: 'studio',
      size: 1,
      kind: 'streamer',
      engine_settings: { HLS_FRAGMENT: '2' },
    });

    const { profiles } = await harness.service.addGroupMembers(group.id, 1);

    assert.deepEqual(profiles[0]!.engine_settings, { HLS_FRAGMENT: '2' });
  });
});
