import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EngineSettingObservation } from '@streaming-infra-manager/common';

import {
  engineDefaultText, engineObservationNote, engineObservationText, engineOverrideHint, engineOverridePlaceholder,
} from './engineObservationText';

const literal: EngineSettingObservation = { status: 'known', source: 'config-file', value: '4', environment: 'none' };

describe('engine observation wording', () => {
  it('names a literal as set in the config file and explains that an override cannot change it', () => {
    const text = engineObservationText(literal, 's');
    assert.equal(text.value, '4 s');
    assert.equal(text.source, 'Set in config file');
    assert.match(engineOverrideHint(literal), /will not change this setting/);
    assert.match(engineOverrideHint(literal), /Edit the config file/);
  });

  it('keeps deployment, host, manager and stack sources distinct', () => {
    for (const [source, label] of [
      ['deployment', 'Deployment override'], ['host', 'Host default'], ['manager', 'Manager default'], ['stack', 'Stack default'],
    ] as const) {
      const observation: EngineSettingObservation = { status: 'known', source, value: '2', environment: 'all' };
      assert.equal(engineObservationText(observation).source, label);
      assert.equal(engineOverrideHint(observation), 'This config reads the override in every relevant section.');
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
    assert.match(engineOverrideHint(ignored), /will not change this setting/);
  });

  it('puts the reason in the drawer note for a value the engine applies, and nothing extra for the rest', () => {
    const ignored: EngineSettingObservation = { status: 'known', source: 'built-in', value: '120', environment: 'none', reason: 'latency-without-recvlatency' };
    const stored: EngineSettingObservation = { status: 'known', source: 'deployment', value: '2', environment: 'all' };

    assert.match(engineObservationNote(ignored, 'milliseconds'), /^Configured value: 120 milliseconds\. Engine default\. SRS ignores latency for ingest without recvlatency/);
    assert.equal(engineObservationNote(stored, 'seconds'), 'Configured value: 2 seconds. Deployment override.');
    assert.match(engineObservationNote({ status: 'unknown', source: 'omitted', reason: 'missing-directive', value: null, environment: 'none' }), /^Not specified\. At least one relevant section/);
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
    assert.equal(engineOverrideHint(version), 'Changing this setting will not change the wait on ingest on this stack version.');
    assert.equal(engineOverridePlaceholder(version), 'Stack version controls value');
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
    assert.equal(engineOverrideHint(version), 'Changing this setting will not change the wait on ingest on this stack version.');
    assert.equal(engineOverridePlaceholder(version), 'Stack version controls value');
  });

  it('keeps the config file wording where a file of the deployment own decides the value', () => {
    const ignored: EngineSettingObservation = {
      status: 'known', source: 'built-in', value: '120', environment: 'none', reason: 'latency-without-recvlatency',
    };

    assert.match(engineOverrideHint(ignored), /Edit the config file to change it/);
    assert.equal(engineOverridePlaceholder(ignored), 'Config controls value');
    assert.equal(engineOverridePlaceholder(literal), 'Config controls value');
    assert.equal(engineOverridePlaceholder(undefined), 'Config use unverified');
  });

  it("names whose default an empty field falls back to, the manager's included", () => {
    assert.equal(engineDefaultText('6', 'host', ' seconds'), 'Default 6 seconds, set on this host');
    assert.equal(engineDefaultText('2000', 'manager', ' milliseconds'), 'Manager default 2000 milliseconds');
    assert.equal(engineDefaultText('15', 'stack', ' seconds'), 'Stack default 15 seconds');
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
