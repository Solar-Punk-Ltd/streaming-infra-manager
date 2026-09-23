import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OME_SERVICE, SRS_SERVICE } from './constants.js';
import { effectiveEngineDefaults } from './engineDefaults.js';
import { isEnvSafeValue } from './envSafeValue.js';
import {
  applicableEngineSettings,
  effectiveEngineSettings,
  engineSettingsEnv,
  engineSettingsFields,
  engineSettingsFieldsFor,
  engineSettingsProblem,
  OME_SETTINGS,
  SRS_SETTINGS,
} from './engineSettings.js';

const ABR = { abr: true };
const PLAIN = { abr: false };

/** Every field of the engine at its own default, as a settings object. */
const ownDefaults = (engine: typeof SRS_SERVICE | typeof OME_SERVICE) =>
  Object.fromEntries(engineSettingsFields(engine).map((field) => [field.key, field.defaultValue]));

describe('the field lists', () => {
  it('accepts its own defaults, on both engines', () => {
    // The list is the only place these numbers exist. A default outside its own
    // bounds would open the drawer already showing an error.
    assert.equal(
      engineSettingsProblem(SRS_SERVICE, ownDefaults(SRS_SERVICE), ABR),
      null,
    );
    assert.equal(
      engineSettingsProblem(OME_SERVICE, ownDefaults(OME_SERVICE), PLAIN),
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

  it("names two seconds as the manager's own segment length", () => {
    const field = (key: string) =>
      SRS_SETTINGS.find((candidate) => candidate.key === key);

    assert.equal(field('HLS_FRAGMENT')?.defaultValue, '2');
    assert.equal(field('HLS_WINDOW')?.defaultValue, '15');
  });

  it('keeps the ABR fields out of a deployment that does not encode a ladder', () => {
    const plain = engineSettingsFieldsFor(SRS_SERVICE, PLAIN).map((f) => f.key);
    assert.deepEqual(plain, ['HLS_FRAGMENT', 'HLS_SEGMENT_MAX', 'HLS_WINDOW', 'SRT_LATENCY']);
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
    // Only the frame rate is set, so the rule has to pick up HLS_FRAGMENT from
    // the field's own default, which is what answers where no version contract
    // and no host value were read. Two seconds is a whole number of frames at
    // every whole frame rate, so what the rule used is named by the pair that
    // stores a shorter one.
    assert.equal(engineSettingsProblem(SRS_SERVICE, { ABR_FPS: '25' }, ABR), null);
    assert.match(
      engineSettingsProblem(
        SRS_SERVICE,
        { ABR_FPS: '25', HLS_FRAGMENT: '1.5' },
        ABR,
      ) ?? '',
      /segment length 1\.5 is 37\.5 frames/,
    );
  });

  it('accepts two second segments at every frame rate an operator names', () => {
    // Two seconds is the manager's own default, so a whole number of frames at
    // the rates a publisher actually sends is what makes that default usable.
    for (const fps of ['25', '30', '60']) {
      assert.equal(
        engineSettingsProblem(
          SRS_SERVICE,
          { ABR_FPS: fps, HLS_FRAGMENT: '2' },
          ABR,
        ),
        null,
        `${fps} frames against a 2 second segment should be accepted`,
      );
    }
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
      /cannot be empty.*default of 2/,
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
    // Writing it would be a line the engine ignores. Refusing it would fail the
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
  // The field's own two seconds is whole at every whole frame rate, so it is a
  // host running something shorter that the rule has to read. main-v3 cuts half
  // second pieces, and a host may set a length of its own on top of that.
  const HOST_SHORT = { abr: true, defaults: { HLS_FRAGMENT: '1.5' } };

  it('refuses a frame rate the field default would accept', () => {
    assert.equal(engineSettingsProblem(SRS_SERVICE, { ABR_FPS: '25' }, ABR), null);
    assert.match(
      engineSettingsProblem(SRS_SERVICE, { ABR_FPS: '25' }, HOST_SHORT) ?? '',
      /37\.5 frames/,
    );
  });

  it('accepts a frame rate the host leaves whole, and refuses one it does not', () => {
    assert.equal(
      engineSettingsProblem(SRS_SERVICE, { ABR_FPS: '30' }, HOST_SHORT),
      null,
    );
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
        { abr: true, defaults: { HLS_FRAGMENT: '2' } },
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

describe('the force-close ceiling against the segment length', () => {
  // The SRS entrypoint exits 1 when the ceiling is below the segment length,
  // and compose supplies 2.5 whenever the profile sets none, so a 4 second
  // segment on its own takes a running deployment into a crash loop.
  const STACK_CEILING = { abr: false, defaults: { HLS_SEGMENT_MAX: '2.5' } };

  it('refuses a segment length raised past the ceiling it falls back to', () => {
    assert.match(
      engineSettingsProblem(SRS_SERVICE, { HLS_FRAGMENT: '4' }, STACK_CEILING) ?? '',
      /2\.5 seconds is below the segment length of 4 seconds/,
    );
  });

  it('accepts the same segment length once the ceiling moves with it', () => {
    assert.equal(
      engineSettingsProblem(
        SRS_SERVICE,
        { HLS_FRAGMENT: '4', HLS_SEGMENT_MAX: '4' },
        STACK_CEILING,
      ),
      null,
    );
  });

  it("accepts the manager's own segment length under the ceiling it falls back to", () => {
    assert.equal(
      engineSettingsProblem(SRS_SERVICE, { HLS_FRAGMENT: '2' }, STACK_CEILING),
      null,
    );
    // Unstored, the rule reads the field's own two seconds, so a ceiling set
    // under that is refused in those words.
    assert.match(
      engineSettingsProblem(SRS_SERVICE, { HLS_SEGMENT_MAX: '1' }, PLAIN) ?? '',
      /below the segment length of 2 seconds/,
    );
  });

  it('accepts a segment length equal to the ceiling, as the entrypoint does', () => {
    assert.equal(
      engineSettingsProblem(
        SRS_SERVICE,
        { HLS_FRAGMENT: '2.5' },
        STACK_CEILING,
      ),
      null,
    );
  });

  it('applies to a deployment without the ABR ladder', () => {
    // The only cross-field rule before this one ran under the ladder alone, and
    // this pair is read by every SRS deployment.
    assert.notEqual(
      engineSettingsProblem(
        SRS_SERVICE,
        { HLS_FRAGMENT: '3', HLS_SEGMENT_MAX: '2' },
        PLAIN,
      ),
      null,
    );
  });
});

/**
 * How long SRS waits for a lost SRT packet to be resent. On 2026-09-22 an
 * outside broadcaster lost 5 to 8.5% of its packets, nearly every one was
 * resent, and SRS dropped the resends as too late at the stack's 200 ms, so
 * every drop became a hole in a frame. The owner set 2000 on 2026-09-23.
 */
describe('the SRT latency', () => {
  const latency = () => SRS_SETTINGS.find((field) => field.key === 'SRT_LATENCY');

  it('is an SRS setting in whole milliseconds, 2000 by default', () => {
    const field = latency();

    assert.ok(field, 'the drawer offers nothing for the SRT latency');
    assert.equal(field.kind, 'integer');
    assert.equal(field.unit, 'milliseconds');
    assert.equal(field.defaultValue, '2000');
    assert.equal(field.abrOnly, false);
    assert.equal(field.placeholder, 'SRT_LATENCY_PLACEHOLDER');
  });

  it('says in plain words what it waits for and what raising it costs', () => {
    const help = latency()?.help ?? '';

    assert.match(help, /lost packet/);
    assert.match(help, /delay/);
    assert.match(help, /2000/);
  });

  it('accepts every whole number from 20 to 10000', () => {
    for (const value of ['20', '2000', '10000']) {
      assert.equal(
        engineSettingsProblem(SRS_SERVICE, { SRT_LATENCY: value }, PLAIN),
        null,
        `${value} ms should be accepted`,
      );
    }
  });

  it('refuses a value under 20 or over 10000, and says the bound', () => {
    assert.match(
      engineSettingsProblem(SRS_SERVICE, { SRT_LATENCY: '19' }, PLAIN) ?? '',
      /SRT latency must be at least 20\. Got 19\./,
    );
    assert.match(
      engineSettingsProblem(SRS_SERVICE, { SRT_LATENCY: '10001' }, PLAIN) ?? '',
      /SRT latency must be at most 10000\. Got 10001\./,
    );
  });

  it('refuses a fraction, because SRS reads the directive as a whole number', () => {
    assert.match(
      engineSettingsProblem(SRS_SERVICE, { SRT_LATENCY: '2000.5' }, PLAIN) ?? '',
      /SRT latency must be a whole number\. Got "2000\.5"\./,
    );
  });

  it('reaches SRS when a deployment sets it', () => {
    assert.deepEqual(
      engineSettingsEnv(SRS_SERVICE, { SRT_LATENCY: '3000' }, PLAIN),
      { SRT_LATENCY: '3000' },
    );
  });

  it('is not a setting OvenMediaEngine reads', () => {
    assert.match(
      engineSettingsProblem(OME_SERVICE, { SRT_LATENCY: '2000' }, PLAIN) ?? '',
      /SRT_LATENCY is not a setting the ome engine reads/,
    );
  });

  it('is the one default the manager owns rather than each version', () => {
    // A default the manager owns is written into every deployment's env file
    // that stores none, so adding one is a decision and not a detail.
    const owned = [...SRS_SETTINGS, ...OME_SETTINGS]
      .filter((field) => field.managerOwnsDefault)
      .map((field) => field.key);

    assert.deepEqual(owned, ['SRT_LATENCY']);
  });
});

describe("engineSettingsEnv and the manager's own SRT latency", () => {
  /** What an unset field falls back to on a host whose version cuts v3.1's numbers. */
  const onV31 = (baseEnv: Record<string, string> = {}) => ({
    abr: false,
    defaults: effectiveEngineDefaults(SRS_SERVICE, baseEnv, {
      HLS_FRAGMENT: '0.5',
      HLS_WINDOW: '15',
      SRT_LATENCY: '200',
    }),
  });

  it('writes 2000 where neither the deployment nor the host sets it', () => {
    assert.deepEqual(engineSettingsEnv(SRS_SERVICE, {}, onV31()), { SRT_LATENCY: '2000' });
  });

  it("writes none of the version's own defaults", () => {
    const env = engineSettingsEnv(SRS_SERVICE, { HLS_WINDOW: '30' }, onV31());

    assert.deepEqual(env, { HLS_WINDOW: '30', SRT_LATENCY: '2000' });
  });

  it('leaves a value set on the host to the base env, which the file is a copy of', () => {
    assert.deepEqual(engineSettingsEnv(SRS_SERVICE, {}, onV31({ SRT_LATENCY: '500' })), {});
  });

  it('writes what the deployment stored over the manager default', () => {
    assert.deepEqual(
      engineSettingsEnv(SRS_SERVICE, { SRT_LATENCY: '3000' }, onV31()),
      { SRT_LATENCY: '3000' },
    );
  });

  it('writes nothing of it for OvenMediaEngine', () => {
    const defaults = effectiveEngineDefaults(OME_SERVICE);

    assert.deepEqual(engineSettingsEnv(OME_SERVICE, {}, { abr: false, defaults }), {});
  });
});

describe('what an operator can see about the force-close ceiling', () => {
  const field = (key: string) =>
    SRS_SETTINGS.find((candidate) => candidate.key === key);

  /**
   * The engine cuts a piece without a keyframe once it runs past
   * `HLS_FRAGMENT * hls_aof_ratio`. That ratio was in no field here and in no
   * env sample, so the ceiling it produced was invisible AND it scaled with the
   * segment length, which is a field. Raising the segment length to 2 takes the
   * ceiling from 2.5s to 10s with nothing anywhere saying so.
   */
  it('is a field, in seconds, rather than a hidden multiple of another field', () => {
    const ceiling = field('HLS_SEGMENT_MAX');

    assert.ok(ceiling, 'the drawer offers nothing about the force-close ceiling');
    assert.equal(ceiling.unit, 'seconds');
    assert.doesNotMatch(ceiling.label, /ratio/i);
  });

  it('reaches SRS, so changing it recreates the container that reads it', () => {
    const env = engineSettingsEnv(SRS_SERVICE, { HLS_SEGMENT_MAX: '3.5' }, PLAIN);

    assert.equal(env.HLS_SEGMENT_MAX, '3.5');
  });

  // The segment is `ceil(HLS_FRAGMENT / GOP) * GOP`, measured over 20 arms, so
  // the keyframe interval decides the length and this field is a floor under
  // it. The help used to say to keep the keyframe interval at or below the
  // field, which is the opposite, and is the advice that produced the 10s
  // ceiling.
  it('no longer tells the operator to publish keyframes under the segment length', () => {
    const fragment = field('HLS_FRAGMENT');

    assert.ok(fragment);
    assert.doesNotMatch(fragment.help, /at or below this/i);
    assert.match(fragment.help, /floor|shortest/i);
  });
});

