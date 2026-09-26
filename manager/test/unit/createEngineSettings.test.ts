/**
 * Engine settings sent with a new deployment.
 *
 * Unit test, no database and no deploy script. `pnpm test` in manager/.
 *
 * The wizard picks a segment length before the deployment exists, so the value
 * has to travel on the create body. The settings route cannot take it a moment
 * later: a profile is DEPLOYING from the instant create returns, and that route
 * refuses a busy deployment. An absent value is not an empty one and stays
 * absent, so an API create with nothing to say still runs on whatever the
 * version's own entrypoints fall back to.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createProfileSchema } from '../../src/schemas/profile.js';
import { profileServiceHarness } from '../support/profileServiceHarness.js';

const validate = (value: unknown) =>
  createProfileSchema.validate(value, { abortEarly: false, stripUnknown: true });

describe('what the create body accepts as engine settings', () => {
  it('takes the keys of either engine, as strings', async () => {
    const body = await validate({
      name: 'stage',
      engine_settings: { HLS_FRAGMENT: '2', HLS_SEGMENT_DURATION: '4' },
    });

    assert.deepEqual(body.engine_settings, {
      HLS_FRAGMENT: '2',
      HLS_SEGMENT_DURATION: '4',
    });
  });

  it('strips a key neither engine reads, as the settings route does', async () => {
    const body = await validate({
      name: 'stage',
      engine_settings: { HLS_FRAGMENT: '2', API_PORT: '10000' },
    });

    assert.deepEqual(body.engine_settings, { HLS_FRAGMENT: '2' });
  });

  it('leaves the field out when the body says nothing', async () => {
    const body = await validate({ name: 'stage' });

    assert.equal(body.engine_settings, undefined);
  });
});

describe('engine settings on a new deployment', () => {
  it('stores what the body carries, so the settings card shows it and the deploy writes it', async () => {
    const harness = profileServiceHarness();

    await harness.service.create({
      name: 'stage',
      kind: 'streamer',
      engine_settings: { HLS_FRAGMENT: '2' },
    });

    assert.deepEqual(harness.profiles.rows.get('stage')?.engine_settings, {
      HLS_FRAGMENT: '2',
    });
  });

  it('leaves the column empty when the body says nothing, so the version default stands', async () => {
    const harness = profileServiceHarness();

    await harness.service.create({ name: 'stage', kind: 'streamer' });

    assert.deepEqual(harness.profiles.rows.get('stage')?.engine_settings, {});
  });

  it('holds the value to the rule the settings page applies, and stores nothing', async () => {
    // Four second pieces against the 2.5 second force-close ceiling compose
    // supplies when a profile sets none. The engine exits 1 on that pair, so
    // the create has to as well rather than deploying into a crash loop.
    const harness = profileServiceHarness();

    await assert.rejects(
      harness.service.create({
        name: 'stage',
        kind: 'streamer',
        engine_settings: { HLS_FRAGMENT: '4' },
      }),
      /2\.5 seconds is below the segment length of 4 seconds/,
    );
    assert.equal(harness.profiles.rows.has('stage'), false);
  });

  it('refuses an ABR field on a deployment that encodes no ladder', async () => {
    const harness = profileServiceHarness();

    await assert.rejects(
      harness.service.create({
        name: 'stage',
        kind: 'streamer',
        engine_settings: { ABR_FPS: '30' },
      }),
      /only applies to a deployment that encodes the ABR ladder/,
    );
  });

  it('refuses settings for a deployment that runs no media server', async () => {
    const harness = profileServiceHarness();

    await assert.rejects(
      harness.service.create({
        name: 'stage',
        kind: 'viewer',
        engine_settings: { HLS_FRAGMENT: '2' },
      }),
      /runs no media server/,
    );
  });
});
