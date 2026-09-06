/**
 * What an unset setting falls back to, once the host has a say in it.
 *
 * The case that matters is a base `.env` that already sets one of these keys.
 * `.env.<profile>` is a copy of it and an unset key is left out, so that host
 * value is what the container starts with, and everything that names a default
 * or checks a pair of them has to say so.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OME_SERVICE, SRS_SERVICE } from './constants.js';
import { effectiveEngineDefaults } from './engineDefaults.js';

describe('effectiveEngineDefaults', () => {
  it('answers the stack default for every key when the base env sets none', () => {
    const { values, sources, rejected } = effectiveEngineDefaults(SRS_SERVICE);

    assert.equal(values.HLS_FRAGMENT, '1.5');
    assert.equal(values.ABR_PRESET, 'veryfast');
    assert.equal(sources.HLS_FRAGMENT, 'stack');
    assert.deepEqual(rejected, []);
  });

  it('takes the base env value, and says the host set it', () => {
    const { values, sources } = effectiveEngineDefaults(SRS_SERVICE, {
      HLS_FRAGMENT: '2',
    });

    assert.equal(values.HLS_FRAGMENT, '2');
    assert.equal(sources.HLS_FRAGMENT, 'host');
    // Untouched keys keep the stack's own value and say so.
    assert.equal(values.HLS_WINDOW, '22.5');
    assert.equal(sources.HLS_WINDOW, 'stack');
  });

  it('keeps the stack default when the base env value is one the field refuses', () => {
    const { values, sources, rejected } = effectiveEngineDefaults(SRS_SERVICE, {
      HLS_FRAGMENT: '90',
    });

    assert.equal(values.HLS_FRAGMENT, '1.5');
    assert.equal(sources.HLS_FRAGMENT, 'stack');
    assert.deepEqual(rejected, ['HLS_FRAGMENT']);
  });

  it('treats an empty base env value as unset', () => {
    const { values, sources, rejected } = effectiveEngineDefaults(SRS_SERVICE, {
      HLS_FRAGMENT: '   ',
    });

    assert.equal(values.HLS_FRAGMENT, '1.5');
    assert.equal(sources.HLS_FRAGMENT, 'stack');
    assert.deepEqual(rejected, []);
  });

  it('answers only the keys the engine reads', () => {
    const { values } = effectiveEngineDefaults(OME_SERVICE, {
      API_PORT: '10000',
      HLS_FRAGMENT: '2',
      HLS_SEGMENT_DURATION: '4',
    });

    assert.deepEqual(Object.keys(values).sort(), [
      'HLS_SEGMENT_COUNT',
      'HLS_SEGMENT_DURATION',
      'OME_HLS_POLL_INTERVAL_MS',
    ]);
    assert.equal(values.HLS_SEGMENT_DURATION, '4');
  });
});
