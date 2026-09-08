import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EngineSettingObservation } from '@streaming-infra-manager/common';

import { engineObservationText, engineOverrideHint } from './engineObservationText';

const literal: EngineSettingObservation = { status: 'known', source: 'config-file', value: '4', environment: 'none' };

describe('engine observation wording', () => {
  it('names a literal as set in the config file and explains that an override cannot change it', () => {
    const text = engineObservationText(literal, 's');
    assert.equal(text.value, '4 s');
    assert.equal(text.source, 'Set in config file');
    assert.match(engineOverrideHint(literal), /will not change this setting/);
    assert.match(engineOverrideHint(literal), /Edit the config file/);
  });

  it('keeps deployment, host and stack sources distinct', () => {
    for (const [source, label] of [['deployment', 'Deployment override'], ['host', 'Host default'], ['stack', 'Stack default']] as const) {
      const observation: EngineSettingObservation = { status: 'known', source, value: '2', environment: 'all' };
      assert.equal(engineObservationText(observation).source, label);
      assert.equal(engineOverrideHint(observation), 'This config reads the override in every relevant section.');
    }
  });

  it('does not present missing and conflicting readings as the same absence', () => {
    const omitted = engineObservationText({ status: 'unknown', source: 'omitted', reason: 'missing-directive', value: null, environment: 'partial' });
    const conflict = engineObservationText({ status: 'unknown', source: 'unverified', reason: 'conflicting-values', value: null, environment: 'none' });
    assert.equal(omitted.value, 'Not specified');
    assert.match(omitted.detail, /omits this setting/);
    assert.match(omitted.detail, /default has not been observed/);
    assert.equal(conflict.value, 'Unverified');
    assert.match(conflict.detail, /different values/);
    assert.doesNotMatch(conflict.detail, /omits/);
  });

  it('keeps unsupported syntax and unavailable metadata uncertain', () => {
    for (const reason of ['unsupported-syntax', 'metadata-unavailable'] as const) {
      const text = engineObservationText({ status: 'unknown', source: 'unverified', reason, value: null, environment: 'unknown' });
      assert.equal(text.value, 'Unverified');
      assert.doesNotMatch(text.detail, /not read|not used|omits/);
    }
    assert.match(engineObservationText(undefined).detail, /No current/);
    assert.match(engineOverrideHint(undefined), /unverified/);
  });

  it('does not claim audio bitrate is unused when only some encoders copy audio', () => {
    const allCopy = engineObservationText({ status: 'unknown', source: 'unverified', reason: 'not-applicable', value: null, environment: 'none' });
    const mixed = engineObservationText({ status: 'unknown', source: 'unverified', reason: 'mixed-applicability', value: null, environment: 'unknown' });
    assert.equal(allCopy.value, 'Not applicable');
    assert.match(allCopy.detail, /All relevant encoders copy audio/);
    assert.equal(mixed.value, 'Unverified');
    assert.match(mixed.detail, /Some encoders copy audio/);
  });

  it('states partial and unknown override applicability without claiming it is unused', () => {
    const observation = { status: 'unknown', source: 'unverified', reason: 'mixed-sources', value: null } as const;
    assert.match(engineOverrideHint({ ...observation, environment: 'partial' }), /Only some/);
    assert.match(engineOverrideHint({ ...observation, environment: 'unknown' }), /unverified/);
  });
});
