import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { effectiveEngineDefaults } from './engineDefaults.js';
import { engineSettingsFieldsFor } from './engineSettings.js';
import {
  assembleEngineSettingObservations, environmentSettingReadings, type EngineSettingReading, type EngineSettingReadings,
} from './engineSettingObservation.js';

const fields = engineSettingsFieldsFor('ome', { abr: false });
const defaults = effectiveEngineDefaults('ome', { HLS_SEGMENT_DURATION: '6', HLS_SEGMENT_COUNT: '9' });
const settings = { HLS_SEGMENT_DURATION: '7', HLS_SEGMENT_COUNT: '11', OME_HLS_POLL_INTERVAL_MS: '750' };
const assemble = (readings: EngineSettingReadings) => assembleEngineSettingObservations({ fields, settings, defaults, readings });

describe('engine setting observations', () => {
  it('keeps deployment, validated host and version default precedence for known environment reads', () => {
    const readings = environmentSettingReadings(fields);
    assert.deepEqual(assemble(readings).effective, settings);
    const host = assembleEngineSettingObservations({ fields, settings: {}, defaults, readings });
    assert.equal(host.observations.HLS_SEGMENT_DURATION?.source, 'host');
    assert.equal(host.effective.HLS_SEGMENT_DURATION, '6');
    assert.equal(host.observations.OME_HLS_POLL_INTERVAL_MS?.source, 'stack');
    const version = effectiveEngineDefaults('ome', {}, { HLS_SEGMENT_DURATION: '3' });
    assert.equal(assembleEngineSettingObservations({ fields, settings: {}, defaults: version, readings }).effective.HLS_SEGMENT_DURATION, '3');
  });

  it('a reliable file literal wins over stored and host values without changing an independent uploader setting', () => {
    const result = assemble({
      HLS_SEGMENT_DURATION: [{ kind: 'literal', value: '4' }, { kind: 'literal', value: '4' }],
      HLS_SEGMENT_COUNT: [{ kind: 'literal', value: '8' }],
      OME_HLS_POLL_INTERVAL_MS: [{ kind: 'environment' }],
    });
    assert.deepEqual(result.effective, { HLS_SEGMENT_DURATION: '4', HLS_SEGMENT_COUNT: '8', OME_HLS_POLL_INTERVAL_MS: '750' });
    assert.deepEqual(result.observations.HLS_SEGMENT_DURATION, { status: 'known', source: 'config-file', value: '4', environment: 'none' });
    assert.deepEqual(result.notInConfig, ['HLS_SEGMENT_DURATION', 'HLS_SEGMENT_COUNT']);
  });

  it('does not turn omitted, unreadable or missing readings into defaults', () => {
    const result = assemble({
      HLS_SEGMENT_DURATION: [{ kind: 'omitted' }, { kind: 'environment' }],
      HLS_SEGMENT_COUNT: [{ kind: 'unverified', reason: 'unsupported-syntax' }],
    });
    assert.deepEqual(result.effective, {});
    assert.deepEqual(result.observations.HLS_SEGMENT_DURATION, { status: 'unknown', source: 'omitted', value: null, reason: 'missing-directive', environment: 'partial' });
    assert.equal(result.observations.HLS_SEGMENT_COUNT?.source, 'unverified');
    assert.equal(result.observations.OME_HLS_POLL_INTERVAL_MS?.status, 'unknown');
    assert.deepEqual(result.notInConfig, [], 'uncertainty is not proof environment settings are unused');
  });

  it('keeps conflicting values and mixed sources unknown even when mixed values happen to agree', () => {
    const result = assemble({
      HLS_SEGMENT_DURATION: [{ kind: 'literal', value: '7' }, { kind: 'environment' }],
      HLS_SEGMENT_COUNT: [{ kind: 'literal', value: '8' }, { kind: 'literal', value: '9' }],
      OME_HLS_POLL_INTERVAL_MS: [{ kind: 'environment' }],
    });
    assert.deepEqual(result.effective, { OME_HLS_POLL_INTERVAL_MS: '750' });
    assert.equal(result.observations.HLS_SEGMENT_DURATION?.status === 'unknown' && result.observations.HLS_SEGMENT_DURATION.reason, 'mixed-sources');
    assert.equal(result.observations.HLS_SEGMENT_COUNT?.status === 'unknown' && result.observations.HLS_SEGMENT_COUNT.reason, 'conflicting-values');
  });

  it('rejects an invalid scalar without hiding unrelated proven fields', () => {
    const result = assemble({
      HLS_SEGMENT_DURATION: [{ kind: 'literal', value: '4' }],
      HLS_SEGMENT_COUNT: [{ kind: 'literal', value: 'eight' }],
      OME_HLS_POLL_INTERVAL_MS: [{ kind: 'environment' }],
    });
    assert.deepEqual(result.effective, { HLS_SEGMENT_DURATION: '4', OME_HLS_POLL_INTERVAL_MS: '750' });
    assert.equal(result.observations.HLS_SEGMENT_COUNT?.status === 'unknown' && result.observations.HLS_SEGMENT_COUNT.reason, 'invalid-scalar');
  });

  it("names an unset SRT latency as the manager's own default, whatever the version falls back to", () => {
    const srsFields = engineSettingsFieldsFor('srs', { abr: false });
    const result = assembleEngineSettingObservations({
      fields: srsFields,
      settings: {},
      defaults: effectiveEngineDefaults('srs', {}, { SRT_LATENCY: '200' }),
      readings: environmentSettingReadings(srsFields),
    });

    assert.deepEqual(result.observations.SRT_LATENCY, { status: 'known', source: 'manager', value: '2000', environment: 'all' });
    assert.equal(result.effective.SRT_LATENCY, '2000');
  });

  describe("a value the engine applies of its own accord, because the config leaves out what it reads", () => {
    const srsFields = engineSettingsFieldsFor('srs', { abr: false });
    const withLatency = (...latency: EngineSettingReading[]) => assembleEngineSettingObservations({
      fields: srsFields,
      settings: { SRT_LATENCY: '3000' },
      defaults: effectiveEngineDefaults('srs'),
      readings: { ...environmentSettingReadings(srsFields), SRT_LATENCY: latency },
    });
    const ignored: EngineSettingReading = { kind: 'built-in', value: '120', reason: 'latency-without-recvlatency' };

    it('is known, with its reason, and an override does not reach it', () => {
      const result = withLatency(ignored);

      assert.deepEqual(result.observations.SRT_LATENCY, {
        status: 'known', source: 'built-in', value: '120', environment: 'none', reason: 'latency-without-recvlatency',
      });
      assert.equal(result.effective.SRT_LATENCY, '120', 'what the engine applies, not the stored 3000');
      assert.ok(result.notInConfig.includes('SRT_LATENCY'));
    });

    it('stays unknown beside a reading of another kind, or of another value', () => {
      const mixed = withLatency(ignored, { kind: 'environment' }).observations.SRT_LATENCY;
      const conflicting = withLatency(ignored, { ...ignored, value: '200' }).observations.SRT_LATENCY;

      assert.equal(mixed?.status === 'unknown' && mixed.reason, 'mixed-sources');
      assert.equal(conflicting?.status === 'unknown' && conflicting.reason, 'conflicting-values');
    });
  });

  it('serializes effective as exactly the known observation projection without mutating inputs', () => {
    const input = { fields, settings, defaults, readings: environmentSettingReadings(fields) };
    const before = JSON.stringify(input);
    const result = assembleEngineSettingObservations(input);
    const known = Object.fromEntries(Object.entries(result.observations).filter(([, value]) => value.status === 'known').map(([key, value]) => [key, value.value]));
    assert.deepEqual(JSON.parse(JSON.stringify(result)).effective, known);
    assert.equal(JSON.stringify(input), before);
  });
});
