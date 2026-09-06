/**
 * What saving engine settings recreates, and what clearing the ABR ladder takes
 * with it.
 *
 * Unit test, no database and no deploy script. `pnpm test` in manager/.
 *
 * Both are the same rule from two sides: a stored value has to end up applied
 * to the container that reads it, or be gone. Compose hands one of these keys
 * to the uploader rather than to the engine, so recreating the engine alone
 * leaves the new value applied to nothing. And a rung setting left in the
 * column after the ladder is off is a value nothing will ever read, which the
 * settings check then trips over on every deploy.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { harnessFor, profileRow } from '../support/profileServiceHarness.js';

describe('updateEngineSettings: which containers come back', () => {
  it('recreates the engine alone for a key only the engine reads', async () => {
    const { service, deploys } = harnessFor(profileRow());

    await service.updateEngineSettings('stream1', { HLS_FRAGMENT: '2' });

    assert.deepEqual(deploys, [{ name: 'stream1', services: ['srs'] }]);
  });

  it('recreates the uploader too when the poll interval changes', async () => {
    // OME_HLS_POLL_INTERVAL_MS is in the uploader's environment, not the
    // engine's, so recreating the engine alone would apply nothing.
    const { service, deploys } = harnessFor(
      profileRow({ components: ['ome', 'stream-uploader'] }),
    );

    await service.updateEngineSettings('stream1', {
      OME_HLS_POLL_INTERVAL_MS: '250',
    });

    assert.deepEqual(deploys, [
      { name: 'stream1', services: ['ome', 'stream-uploader'] },
    ]);
  });

  it('recreates the uploader too when the poll interval goes back to the default', async () => {
    // Clearing the field drops the key, which is as much a change as setting
    // one: the uploader is left running with the value that was removed.
    const { service, deploys } = harnessFor(
      profileRow({
        components: ['ome', 'stream-uploader'],
        engine_settings: { OME_HLS_POLL_INTERVAL_MS: '250' },
      }),
    );

    await service.updateEngineSettings('stream1', {});

    assert.deepEqual(deploys, [
      { name: 'stream1', services: ['ome', 'stream-uploader'] },
    ]);
  });

  it('leaves the uploader alone when the poll interval is unchanged', async () => {
    const { service, deploys } = harnessFor(
      profileRow({
        components: ['ome', 'stream-uploader'],
        engine_settings: { OME_HLS_POLL_INTERVAL_MS: '250' },
      }),
    );

    await service.updateEngineSettings('stream1', {
      OME_HLS_POLL_INTERVAL_MS: '250',
      HLS_SEGMENT_COUNT: '8',
    });

    assert.deepEqual(deploys, [{ name: 'stream1', services: ['ome'] }]);
  });
});

describe('update: clearing the ABR pool string', () => {
  const LADDER = ['1080p', '720p', '480p', '360p']
    .map(
      (rung, index) =>
        `${rung}@http://10.0.0.7:${10015 + index * 10}<${'a'.repeat(64)}>`,
    )
    .join(' ');

  function withLadder() {
    return harnessFor(
      profileRow({
        kind: 'custom',
        components: ['srs', 'stream-uploader'],
        bee_publishers: LADDER,
        engine_settings: { HLS_FRAGMENT: '2', ABR_FPS: '30' },
      }),
    );
  }

  it('takes the rung settings out with it', async () => {
    // Left behind, ABR_FPS fails the settings check on every later deploy and
    // the deployment lands in ERROR over a field no drawer renders.
    const { service, stored } = withLadder();

    await service.update('stream1', { bee_publishers: null });

    assert.deepEqual(stored().engine_settings, { HLS_FRAGMENT: '2' });
  });

  it('keeps them while the ladder is still on', async () => {
    const { service, stored } = withLadder();

    await service.update('stream1', { bee_publishers: LADDER, notes: 'tuned' });

    assert.deepEqual(stored().engine_settings, {
      HLS_FRAGMENT: '2',
      ABR_FPS: '30',
    });
  });
});
