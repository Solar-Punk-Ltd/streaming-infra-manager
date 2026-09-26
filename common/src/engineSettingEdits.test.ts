/**
 * What a save of a deployment's settings leaves in its engine settings, and
 * why the engine would refuse that.
 *
 * Unit test. `pnpm test` in common/.
 *
 * The manager judges a save by these, and the settings page by the same ones
 * before it lets Save through, so the page never offers a pair the manager then
 * refuses, and never refuses one the manager would take.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SRS_SERVICE } from './constants.js';
import { effectiveEngineDefaults } from './engineDefaults.js';
import { editsEngineSettings, engineSettingsAfterEdits, engineSettingsSaveProblem } from './engineSettingEdits.js';

/** What an SRS deployment falls back to on a host whose base env sets nothing, the stack's own compose values. */
const HOST = effectiveEngineDefaults(SRS_SERVICE, {}, { HLS_FRAGMENT: '0.5', HLS_SEGMENT_MAX: '2.5' }).values;

describe('engineSettingsAfterEdits', () => {
  it('sets the values a save gives, takes out the keys it resets and keeps the rest', () => {
    const after = engineSettingsAfterEdits({ HLS_WINDOW: '20', SRT_LATENCY: '3000' }, [
      { key: 'HLS_FRAGMENT', value: '1' },
      { key: 'SRT_LATENCY', value: null },
    ]);

    assert.deepEqual(after, { HLS_WINDOW: '20', HLS_FRAGMENT: '1' });
  });

  it('leaves the engine settings alone for a key that is no engine setting', () => {
    const stored = { HLS_WINDOW: '20' };

    assert.deepEqual(engineSettingsAfterEdits(stored, [{ key: 'LOG_LEVEL', value: 'warn' }, { key: 'STAMP', value: null }]), stored);
  });

  it('changes nothing it was given', () => {
    const stored = { HLS_WINDOW: '20' };
    engineSettingsAfterEdits(stored, [{ key: 'HLS_WINDOW', value: null }]);

    assert.deepEqual(stored, { HLS_WINDOW: '20' });
  });
});

describe('editsEngineSettings', () => {
  it('says whether a save names any engine setting', () => {
    assert.equal(editsEngineSettings([{ key: 'LOG_LEVEL', value: 'warn' }, { key: 'HLS_FRAGMENT', value: null }]), true);
    assert.equal(editsEngineSettings([{ key: 'LOG_LEVEL', value: 'warn' }]), false);
  });
});

describe('engineSettingsSaveProblem', () => {
  it('judges the unset half of a pair at what this host falls back to', () => {
    // A 3 second segment under the host's 2.5 second ceiling, which nothing stores.
    assert.match(
      engineSettingsSaveProblem(SRS_SERVICE, { HLS_FRAGMENT: '3' }, { abr: false, defaults: HOST }) ?? '',
      /The force-close ceiling of 2\.5 seconds is below the segment length of 3 seconds/,
    );
    assert.equal(engineSettingsSaveProblem(SRS_SERVICE, { HLS_FRAGMENT: '2' }, { abr: false, defaults: HOST }), null);
  });

  it('applies the keyframe rule to a deployment that encodes the ABR ladder', () => {
    assert.match(
      engineSettingsSaveProblem(SRS_SERVICE, { ABR_FPS: '25', HLS_FRAGMENT: '1.5' }, { abr: true, defaults: HOST }) ?? '',
      /Frame rate 25 times segment length 1\.5 is 37\.5 frames/,
    );
  });

  it('passes over a rung setting left behind when the ladder was turned off, which nothing reads', () => {
    assert.equal(
      engineSettingsSaveProblem(SRS_SERVICE, { ABR_FPS: '25', HLS_FRAGMENT: '1' }, { abr: false, defaults: HOST }),
      null,
    );
  });

  it('names a stored value the engine would refuse, whoever typed it', () => {
    assert.equal(
      engineSettingsSaveProblem(SRS_SERVICE, { HLS_WINDOW: '0' }, { abr: false, defaults: HOST }),
      'Playlist window must be at least 1. Got 0.',
    );
  });
});
