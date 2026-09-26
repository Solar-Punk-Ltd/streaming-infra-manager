import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EngineSettingObservation } from '@streaming-infra-manager/common';

import { engineObservationText } from './engineObservationText';

const literal: EngineSettingObservation = { status: 'known', source: 'config-file', value: '4', environment: 'none' };

describe('engine observation wording', () => {
  it('names a literal as set in the config file', () => {
    const text = engineObservationText(literal, 's');
    assert.equal(text.value, '4 s');
    assert.equal(text.source, 'Set in config file');
  });

  it('keeps deployment, host, manager and stack sources distinct', () => {
    for (const [source, label] of [
      ['deployment', 'Deployment override'], ['host', 'Host default'], ['manager', 'Manager default'], ['stack', 'Stack default'],
    ] as const) {
      const observation: EngineSettingObservation = { status: 'known', source, value: '2', environment: 'all' };
      assert.equal(engineObservationText(observation).source, label);
    }
  });

  it("names SRS's own value as the engine's, and says in plain words why the config does not set it", () => {
    const ignored: EngineSettingObservation = { status: 'known', source: 'built-in', value: '120', environment: 'none', reason: 'latency-without-recvlatency' };
    const absent: EngineSettingObservation = { ...ignored, reason: 'no-recvlatency' };

    const text = engineObservationText(ignored, 'milliseconds');
    assert.equal(text.value, '120 milliseconds');
    assert.equal(text.source, 'Engine default');
    assert.match(text.detail, /SRS ignores latency for ingest without recvlatency/);
    assert.match(engineObservationText(absent).detail, /sets no recvlatency/);
    assert.doesNotMatch(engineObservationText(absent).detail, /ignores latency/);
  });

  it("says on a stack version that fills only latency that changing the setting will not change ingest there", () => {
    const version: EngineSettingObservation = {
      status: 'known', source: 'built-in', value: '120', environment: 'none', reason: 'version-without-recvlatency',
    };

    const text = engineObservationText(version, 'milliseconds');
    assert.equal(text.value, '120 milliseconds');
    assert.equal(text.source, 'Engine default');
    assert.match(text.detail, /SRS ignores latency for ingest without recvlatency/);
    assert.match(text.detail, /This stack version's template sets latency and no recvlatency/);
  });

  it('says on a stack version that never reads the setting that its template decides the wait', () => {
    const version: EngineSettingObservation = {
      status: 'known', source: 'built-in', value: '120', environment: 'none', reason: 'version-without-setting',
    };

    const text = engineObservationText(version, 'milliseconds');
    assert.equal(text.value, '120 milliseconds');
    assert.equal(text.source, 'Engine default');
    assert.match(text.detail, /This stack version does not read this setting\./);
    assert.match(text.detail, /SRS's own default/);
    assert.doesNotMatch(text.detail, /[;\u2014]/);
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
  });

  it('does not claim audio bitrate is unused when only some encoders copy audio', () => {
    const allCopy = engineObservationText({ status: 'unknown', source: 'unverified', reason: 'not-applicable', value: null, environment: 'none' });
    const mixed = engineObservationText({ status: 'unknown', source: 'unverified', reason: 'mixed-applicability', value: null, environment: 'unknown' });
    assert.equal(allCopy.value, 'Not applicable');
    assert.match(allCopy.detail, /All relevant encoders copy audio/);
    assert.equal(mixed.value, 'Unverified');
    assert.match(mixed.detail, /Some encoders copy audio/);
  });

});
