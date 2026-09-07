import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OME_SERVICE, SRS_SERVICE } from './constants.js';
import { isEnvSafeValue } from './envSafeValue.js';
import {
  applicableEngineSettings,
  effectiveEngineSettings,
  engineSettingsDefaults,
  engineSettingsEnv,
  engineSettingsFields,
  engineSettingsFieldsFor,
  engineSettingsProblem,
  OME_SETTINGS,
  SRS_SETTINGS,
} from './engineSettings.js';

const ABR = { abr: true };
const PLAIN = { abr: false };

describe('the field lists', () => {
  it('accepts its own defaults, on both engines', () => {
    // The list is the only place these numbers exist. A default outside its own
    // bounds would open the drawer already showing an error.
    assert.equal(
      engineSettingsProblem(SRS_SERVICE, engineSettingsDefaults(SRS_SERVICE), ABR),
      null,
    );
    assert.equal(
      engineSettingsProblem(OME_SERVICE, engineSettingsDefaults(OME_SERVICE), PLAIN),
      null,
    );
  });

  it('accepts every choice a choice field offers', () => {
    for (const field of [...SRS_SETTINGS, ...OME_SETTINGS]) {
      for (const choice of field.choices ?? []) {
        const engine = SRS_SETTINGS.includes(field) ? SRS_SERVICE : OME_SERVICE;
        assert.equal(
          engineSettingsProblem(engine, { [field.key]: choice }, ABR),
          null,
          `${field.key}=${choice} should be accepted`,
        );
      }
    }
  });

  it('offers only choices the entrypoint can splice', () => {
    // The character rule no longer runs on a choice, because membership of this
    // list is the stronger guarantee. That holds only while the list does.
    for (const field of [...SRS_SETTINGS, ...OME_SETTINGS]) {
      for (const choice of field.choices ?? []) {
        assert.ok(isEnvSafeValue(choice), `${choice} must be env safe`);
      }
    }
  });

  it('keeps the ABR fields out of a deployment that does not encode a ladder', () => {
    const plain = engineSettingsFieldsFor(SRS_SERVICE, PLAIN).map((f) => f.key);
    assert.deepEqual(plain, ['HLS_FRAGMENT', 'HLS_WINDOW']);
    assert.equal(
      engineSettingsFieldsFor(SRS_SERVICE, ABR).length,
      engineSettingsFields(SRS_SERVICE).length,
    );
  });
});

describe('the keyframe rule', () => {
  it('refuses 25 frames against a 1.5 second segment', () => {
    const problem = engineSettingsProblem(
      SRS_SERVICE,
      { ABR_FPS: '25', HLS_FRAGMENT: '1.5' },
      ABR,
    );
    assert.match(problem ?? '', /37\.5 frames, which is not a whole number/);
  });

  it('accepts 30 frames against the same segment', () => {
    assert.equal(
      engineSettingsProblem(
        SRS_SERVICE,
        { ABR_FPS: '30', HLS_FRAGMENT: '1.5' },
        ABR,
      ),
      null,
    );
  });

  it('reads the stack default for whichever of the two is not stored', () => {
    // Only the frame rate is set, so the rule has to pick up HLS_FRAGMENT=1.5
    // from the defaults, which is what the container would run with.
    assert.match(
      engineSettingsProblem(SRS_SERVICE, { ABR_FPS: '25' }, ABR) ?? '',
      /not a whole number/,
    );
    assert.equal(engineSettingsProblem(SRS_SERVICE, { ABR_FPS: '30' }, ABR), null);
  });

  it('does not apply to a deployment without the ladder', () => {
    assert.equal(
      engineSettingsProblem(SRS_SERVICE, { HLS_FRAGMENT: '1.7' }, PLAIN),
      null,
    );
  });

  it('answers on decimals a float would get wrong', () => {
    // 3 x 0.1 is 0.30000000000000004 as a float, and 10 x 0.7 is
    // 6.999999999999999. Both products are whole and must be accepted.
    assert.equal(
      engineSettingsProblem(
        SRS_SERVICE,
        { ABR_FPS: '30', HLS_FRAGMENT: '0.7' },
        ABR,
      ),
      null,
    );
  });
});

describe('out of range and non numeric values', () => {
  it('names the field and the bound', () => {
    assert.match(
      engineSettingsProblem(SRS_SERVICE, { ABR_FPS: '240' }, ABR) ?? '',
      /Frame rate must be at most 120\. Got 240\./,
    );
    assert.match(
      engineSettingsProblem(SRS_SERVICE, { ABR_FPS: '0' }, ABR) ?? '',
      /Frame rate must be at least 1\. Got 0\./,
    );
    assert.match(
      engineSettingsProblem(OME_SERVICE, { HLS_SEGMENT_COUNT: '1' }, PLAIN) ?? '',
      /Segment count must be at least 2\./,
    );
  });

  it('names a value that is not a number at all', () => {
    assert.match(
      engineSettingsProblem(SRS_SERVICE, { HLS_FRAGMENT: 'two' }, PLAIN) ?? '',
      /Segment length must be a positive number, use a period for decimals\. Got two\./,
    );
    assert.match(
      engineSettingsProblem(SRS_SERVICE, { ABR_FPS: '29.97' }, ABR) ?? '',
      /Frame rate must be a whole number\. Got "29\.97"\./,
    );
  });

  it('names a choice that is not on the list', () => {
    assert.match(
      engineSettingsProblem(SRS_SERVICE, { ABR_PRESET: 'turbo' }, ABR) ?? '',
      /Encoder preset must be one of ultrafast, .*\. Got "turbo"\./,
    );
  });

  it('refuses an empty value, and says how to go back to the default', () => {
    assert.match(
      engineSettingsProblem(SRS_SERVICE, { HLS_FRAGMENT: '  ' }, PLAIN) ?? '',
      /cannot be empty.*stack default of 1\.5/,
    );
  });

  it('refuses a key the engine does not read', () => {
    assert.match(
      engineSettingsProblem(SRS_SERVICE, { HLS_SEGMENT_COUNT: '5' }, PLAIN) ?? '',
      /HLS_SEGMENT_COUNT is not a setting the srs engine reads/,
    );
  });

  it('refuses an ABR field on a deployment that does not encode a ladder', () => {
    assert.match(
      engineSettingsProblem(SRS_SERVICE, { ABR_FPS: '30' }, PLAIN) ?? '',
      /Frame rate only applies to a deployment that encodes the ABR ladder/,
    );
  });
});

describe('values the entrypoint could not splice', () => {
  // Every value is spliced into a `sed s///` expression by the entrypoint, where
  // `/` ends the expression and `&` expands to the whole match, so a value with
  // either in it writes a config the engine cannot parse and the container
  // crash-loops under `restart: unless-stopped`.
  it('refuses one on a number field, and says what a number looks like', () => {
    for (const bad of ['1/2', '1&2', "1'2", '1 2', '1"2']) {
      assert.match(
        engineSettingsProblem(SRS_SERVICE, { HLS_FRAGMENT: bad }, PLAIN) ?? '',
        /Segment length must be a positive number, use a period for decimals\./,
        `should refuse ${bad}`,
      );
    }
  });

  it('answers a decimal comma with the period rule, not the character set', () => {
    // What the character rule said was true and useless: an operator who typed
    // a comma needs to be told to type a period, not which characters an env
    // file allows.
    assert.match(
      engineSettingsProblem(SRS_SERVICE, { HLS_FRAGMENT: '1,5' }, PLAIN) ?? '',
      /Segment length must be a positive number, use a period for decimals\. Got 1,5\./,
    );
  });

  it('refuses one on a choice field', () => {
    assert.match(
      engineSettingsProblem(SRS_SERVICE, { ABR_PRESET: 'very/fast' }, ABR) ?? '',
      /Encoder preset must be one of/,
    );
  });

  it('takes six fraction digits and no more', () => {
    // The keyframe rule scales by ten to the number of digits, so the fraction
    // is what bounds that arithmetic.
    assert.equal(
      engineSettingsProblem(SRS_SERVICE, { HLS_WINDOW: '22.500000' }, PLAIN),
      null,
    );
    assert.match(
      engineSettingsProblem(SRS_SERVICE, { HLS_WINDOW: '22.5000000' }, PLAIN) ??
        '',
      /must be a positive number, use a period for decimals/,
    );
  });
});

describe('engineSettingsEnv', () => {
  it('writes the stored keys and nothing else', () => {
    assert.deepEqual(
      engineSettingsEnv(
        SRS_SERVICE,
        { HLS_FRAGMENT: '2', ABR_PRESET: 'faster' },
        ABR,
      ),
      { HLS_FRAGMENT: '2', ABR_PRESET: 'faster' },
    );
  });

  it('drops a rung setting stored before the ladder was turned off', () => {
    // The key stays in the column when the pool string is cleared elsewhere.
    // Writing it would be a line the engine ignores; refusing it would fail the
    // deploy over a value no drawer renders.
    assert.deepEqual(
      engineSettingsEnv(
        SRS_SERVICE,
        { HLS_FRAGMENT: '2', ABR_PRESET: 'faster' },
        PLAIN,
      ),
      { HLS_FRAGMENT: '2' },
    );
  });

  it('leaves an unset key out, so the host .env still decides it', () => {
    assert.deepEqual(engineSettingsEnv(SRS_SERVICE, {}), {});
    assert.deepEqual(engineSettingsEnv(SRS_SERVICE, { HLS_WINDOW: '  ' }), {});
  });

  it('drops a key the engine does not read', () => {
    assert.deepEqual(
      engineSettingsEnv(OME_SERVICE, {
        HLS_SEGMENT_COUNT: '8',
        ABR_PRESET: 'faster',
      }),
      { HLS_SEGMENT_COUNT: '8' },
    );
  });

  it('renders in the field list order, whatever order it was given', () => {
    assert.deepEqual(
      Object.keys(
        engineSettingsEnv(
          SRS_SERVICE,
          { ABR_PRESET: 'fast', HLS_WINDOW: '30', HLS_FRAGMENT: '2' },
          ABR,
        ),
      ),
      ['HLS_FRAGMENT', 'HLS_WINDOW', 'ABR_PRESET'],
    );
  });
});

describe('applicableEngineSettings', () => {
  it('keeps what the deployment still reads and drops the rest', () => {
    assert.deepEqual(
      applicableEngineSettings(
        SRS_SERVICE,
        { HLS_FRAGMENT: '2', ABR_FPS: '30', HLS_SEGMENT_COUNT: '5' },
        PLAIN,
      ),
      { HLS_FRAGMENT: '2' },
    );
  });

  it('keeps the rung settings while the ladder is on', () => {
    assert.deepEqual(
      applicableEngineSettings(
        SRS_SERVICE,
        { HLS_FRAGMENT: '2', ABR_FPS: '30' },
        ABR,
      ),
      { HLS_FRAGMENT: '2', ABR_FPS: '30' },
    );
  });
});

describe('effectiveEngineSettings', () => {
  it('fills every key the engine reads, stored value first', () => {
    const effective = effectiveEngineSettings(OME_SERVICE, {
      HLS_SEGMENT_COUNT: '8',
    });
    assert.equal(effective.HLS_SEGMENT_COUNT, '8');
    assert.equal(effective.HLS_SEGMENT_DURATION, '2');
    assert.equal(effective.OME_HLS_POLL_INTERVAL_MS, '500');
  });

  it('falls back to the host default before the stack one', () => {
    const effective = effectiveEngineSettings(
      OME_SERVICE,
      { HLS_SEGMENT_COUNT: '8' },
      { HLS_SEGMENT_DURATION: '4' },
    );
    assert.equal(effective.HLS_SEGMENT_COUNT, '8');
    assert.equal(effective.HLS_SEGMENT_DURATION, '4');
    assert.equal(effective.OME_HLS_POLL_INTERVAL_MS, '500');
  });

  it('lets a stored value beat the host default', () => {
    const effective = effectiveEngineSettings(
      OME_SERVICE,
      { HLS_SEGMENT_DURATION: '6' },
      { HLS_SEGMENT_DURATION: '4' },
    );
    assert.equal(effective.HLS_SEGMENT_DURATION, '6');
  });
});

describe('the keyframe rule against a host default', () => {
  // The host runs 2 second segments, so 25 frames a second is 50 frames a
  // segment and the pair the stack default refuses is one the container starts
  // with.
  const HOST_TWO_SECOND = { abr: true, defaults: { HLS_FRAGMENT: '2' } };

  it('accepts a frame rate the stack default would refuse', () => {
    assert.match(
      engineSettingsProblem(SRS_SERVICE, { ABR_FPS: '25' }, ABR) ?? '',
      /37\.5 frames/,
    );
    assert.equal(
      engineSettingsProblem(SRS_SERVICE, { ABR_FPS: '25' }, HOST_TWO_SECOND),
      null,
    );
  });

  it('refuses a frame rate the stack default would accept', () => {
    assert.equal(engineSettingsProblem(SRS_SERVICE, { ABR_FPS: '30' }, ABR), null);
    assert.match(
      engineSettingsProblem(SRS_SERVICE, { ABR_FPS: '30' }, {
        abr: true,
        defaults: { HLS_FRAGMENT: '1.25' },
      }) ?? '',
      /segment length 1\.25 is 37\.5 frames/,
    );
  });

  it('leaves a stored segment length in charge of the rule', () => {
    assert.match(
      engineSettingsProblem(
        SRS_SERVICE,
        { ABR_FPS: '25', HLS_FRAGMENT: '1.5' },
        HOST_TWO_SECOND,
      ) ?? '',
      /37\.5 frames/,
    );
  });
});

describe('effectiveEngineSettings on a deployment whose config file dropped a key', () => {
  it('leaves that key out rather than naming a value nothing reads', () => {
    const effective = effectiveEngineSettings(
      'srs',
      { HLS_WINDOW: '20' },
      { HLS_FRAGMENT: '0.5' },
      ['HLS_WINDOW'],
    );

    assert.equal(effective.HLS_FRAGMENT, '0.5');
    assert.equal('HLS_WINDOW' in effective, false);
  });
});
