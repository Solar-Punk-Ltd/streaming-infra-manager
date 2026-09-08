import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assembleEngineSettingObservations, effectiveEngineDefaults, engineSettingsFieldsFor } from '@streaming-infra-manager/common';
import { srsSettingReadings } from '../../src/domain/engineConfig/srsSettingReadings.js';

const template = 'vhost __defaultVhost__ { hls { hls_fragment HLS_FRAGMENT_PLACEHOLDER; hls_window HLS_WINDOW_PLACEHOLDER; }\nTRANSCODE_PLACEHOLDER\n}\nABR_VHOST_PLACEHOLDER\n';
const hls = (fragment = '4', window = '30') => `hls { hls_fragment ${fragment}; hls_window ${window}; }`;
const engine = (name: string, codec = 'aac', bitrate: string | null = '128', extra = '') =>
  `engine ${name} { vfps 25; vpreset fast; vprofile main; vthreads 2; acodec ${codec}; ${bitrate === null ? '' : `abitrate ${bitrate};`} ${extra} }`;
const config = (encoders = '', hlsText = hls()) => `vhost main { ${hlsText} ${encoders ? `transcode { ${encoders} }` : ''} }`;

function observe(file: string | null, abr = true, selectedTemplate: string | null = template) {
  const fields = engineSettingsFieldsFor('srs', { abr });
  return assembleEngineSettingObservations({
    fields, settings: { HLS_FRAGMENT: '7', HLS_WINDOW: '45', ABR_FPS: '30' },
    defaults: effectiveEngineDefaults('srs', { HLS_FRAGMENT: '6' }),
    readings: srsSettingReadings(selectedTemplate, file, fields, { abr }),
  });
}

function reason(result: ReturnType<typeof observe>, key: string) {
  const observation = result.observations[key]!;
  assert.equal(observation.status, 'unknown');
  return observation.status === 'unknown' ? observation.reason : undefined;
}

describe('bounded SRS config observations', () => {
  it('reads literal HLS values over stored settings, and supported template placeholders from environment', () => {
    const literal = observe(config(), false);
    assert.deepEqual(literal.effective, { HLS_FRAGMENT: '4', HLS_WINDOW: '30' });
    assert.equal(literal.observations.HLS_FRAGMENT.source, 'config-file');
    const environment = observe(template, false);
    assert.deepEqual(environment.effective, { HLS_FRAGMENT: '7', HLS_WINDOW: '45' });
    assert.equal(environment.observations.HLS_FRAGMENT.source, 'deployment');
  });

  it('reads quoted scalars and ignores comments and unrelated branches', () => {
    const file = `# hls_fragment 19; }\nvhost "main" { hls { hls_fragment "4"; # HLS_FRAGMENT_PLACEHOLDER\nhls_window '30'; } unrelated { hls_fragment 29; label "a#b;{}"; } }`;
    assert.deepEqual(observe(file, false).effective, { HLS_FRAGMENT: '4', HLS_WINDOW: '30' });
  });

  it('enumerates every matching vhost scope and observes conflicts or missing leaves', () => {
    const same = observe(`${config()} vhost extra { ${hls()} }`, false);
    assert.equal(same.effective.HLS_FRAGMENT, '4');
    const conflicting = observe(`${config()} vhost extra { ${hls('5')} }`, false);
    assert.equal(reason(conflicting, 'HLS_FRAGMENT'), 'conflicting-values');
    const missing = observe(`${config()} vhost extra { hls { hls_window 30; } }`, false);
    assert.equal(missing.observations.HLS_FRAGMENT.source, 'omitted');
    assert.equal(missing.effective.HLS_WINDOW, '30');
  });

  it('rejects duplicate scalar directives and duplicate scope identities per field', () => {
    const duplicate = observe(config('', 'hls { hls_fragment 4; hls_fragment 4; hls_window 30; }'), false);
    assert.equal(reason(duplicate, 'HLS_FRAGMENT'), 'ambiguous-path');
    assert.equal(duplicate.effective.HLS_WINDOW, '30');
    assert.deepEqual(observe(`${config()} ${config()}`, false).effective, {});
  });

  it('reads every explicit encoder scalar and refuses to derive VBV from arithmetic', () => {
    const result = observe(config(engine('low', 'aac', '128', 'vparams { maxrate 700k; bufsize 1400k; }')));
    assert.deepEqual(result.effective, {
      HLS_FRAGMENT: '4', HLS_WINDOW: '30', ABR_FPS: '25', ABR_PRESET: 'fast', ABR_PROFILE: 'main',
      ABR_THREADS: '2', ABR_ACODEC: 'aac', ABR_AUDIO_BITRATE: '128',
    });
    assert.equal(reason(result, 'ABR_VBV_SECONDS'), 'unsupported-syntax');
  });

  it('requires every explicit encoder to agree and keep each mapped directive', () => {
    const conflicting = observe(config(engine('low') + engine('high').replace('vfps 25;', 'vfps 50;')));
    assert.equal(reason(conflicting, 'ABR_FPS'), 'conflicting-values');
    assert.equal(conflicting.effective.ABR_PRESET, 'fast');
    const missing = observe(config(engine('low') + engine('high').replace('vthreads 2;', '')));
    assert.equal(missing.observations.ABR_THREADS.source, 'omitted');
    assert.equal(missing.effective.ABR_FPS, '25');
  });

  it('marks bitrate not applicable only when all explicit encoders unambiguously copy', () => {
    const result = observe(config(engine('low', 'copy') + engine('high', 'copy', null)));
    assert.equal(reason(result, 'ABR_AUDIO_BITRATE'), 'not-applicable');
    assert.equal(result.observations.ABR_AUDIO_BITRATE.environment, 'none');
    assert.equal(result.effective.ABR_AUDIO_BITRATE, undefined);
    assert.equal(result.effective.ABR_ACODEC, 'copy');
  });

  it('reads agreeing AAC bitrates and marks an absent AAC bitrate omitted', () => {
    assert.equal(observe(config(engine('low') + engine('high'))).effective.ABR_AUDIO_BITRATE, '128');
    const absent = observe(config(engine('low') + engine('high', 'aac', null)));
    assert.equal(absent.observations.ABR_AUDIO_BITRATE.source, 'omitted');
    assert.equal(absent.effective.ABR_FPS, '25');
  });

  it('does not call mixed or unknown codecs unused', () => {
    const mixed = observe(config(engine('low', 'copy') + engine('high', 'aac')));
    assert.equal(reason(mixed, 'ABR_AUDIO_BITRATE'), 'mixed-applicability');
    assert.equal(mixed.observations.ABR_AUDIO_BITRATE.environment, 'unknown');
    const unknown = observe(config(engine('low', 'opus')));
    assert.equal(reason(unknown, 'ABR_AUDIO_BITRATE'), 'codec-unverified');
    assert.equal(unknown.effective.ABR_FPS, '25');
  });

  it('an opaque generated encoder prevents an all-copy applicability claim', () => {
    const file = config(engine('low', 'copy')).replace('transcode {', '\nTRANSCODE_PLACEHOLDER\ntranscode {');
    const result = observe(file);
    assert.equal(reason(result, 'ABR_AUDIO_BITRATE'), 'unsupported-syntax');
    assert.equal(result.effective.ABR_ACODEC, undefined);
    assert.equal(result.effective.HLS_FRAGMENT, '4');
  });

  it('an opaque generated vhost affects HLS but leaves explicit encoder fields proven', () => {
    const result = observe(`${config(engine('low'))}\nABR_VHOST_PLACEHOLDER\n`);
    assert.equal(result.effective.HLS_FRAGMENT, undefined);
    assert.equal(reason(result, 'HLS_FRAGMENT'), 'unsupported-syntax');
    assert.equal(result.effective.ABR_FPS, '25');
    assert.equal(result.effective.ABR_AUDIO_BITRATE, '128');
  });

  it('scopes include uncertainty and never follows include paths', () => {
    const hlsInclude = observe(config(engine('low'), 'hls { hls_fragment 4; hls_window 30; include unavailable.conf; }'));
    assert.equal(hlsInclude.effective.HLS_FRAGMENT, undefined);
    assert.equal(hlsInclude.effective.ABR_FPS, '25');
    const encoderInclude = observe(config(engine('low', 'aac', '128', 'include unavailable.conf;')));
    assert.equal(encoderInclude.effective.ABR_FPS, undefined);
    assert.equal(encoderInclude.effective.HLS_FRAGMENT, '4');
    assert.deepEqual(observe(`include unavailable.conf; ${config(engine('low'))}`).effective, {});
  });

  it('does not invent values from malformed, oversized, deeply nested or absent config', () => {
    for (const file of [null, 'vhost main {', 'vhost main { hls { hls_fragment "4; } }', 'x '.repeat(70_000), 'x {'.repeat(70) + '}'.repeat(70)]) {
      assert.deepEqual(observe(file).effective, {});
    }
  });

  it('missing template metadata hides HLS while independent explicit encoder directives stay readable', () => {
    const result = observe(config(engine('low')), true, null);
    assert.equal(reason(result, 'HLS_FRAGMENT'), 'metadata-unavailable');
    assert.equal(result.effective.ABR_FPS, '25');
  });

  it('does not observe literals on lines whose embedded generation marker can replace or delete their structure', () => {
    for (const file of [
      config(engine('low')).replace('hls_fragment 4;', 'hls_fragment 4; # TRANSCODE_PLACEHOLDER\n'),
      `# ABR_VHOST_PLACEHOLDER\n${config(engine('low'))}`,
      config(engine('low')).replace('hls_fragment 4;', 'label "TRANSCODE_PLACEHOLDER"; hls_fragment 4;'),
      `${config(engine('low'))} TRANSCODE_PLACEHOLDER\n`,
    ]) {
      assert.deepEqual(observe(file).effective, {});
    }
  });

  it('does not treat a second same-line scalar placeholder as substituted', () => {
    const scope = (name: string) => `vhost ${name} { ${hls('HLS_FRAGMENT_PLACEHOLDER')} }`;
    const result = observe(`${scope('one')} ${scope('two')}`, false);
    assert.equal(reason(result, 'HLS_FRAGMENT'), 'unsupported-syntax');
    assert.equal(result.effective.HLS_WINDOW, '30');
    assert.equal(observe(`${scope('one')}\n${scope('two')}`, false).effective.HLS_FRAGMENT, '7');
  });

  it('notices when an unrelated earlier token consumes the scalar substitution on that line', () => {
    const result = observe(`label "HLS_FRAGMENT_PLACEHOLDER"; ${config('', hls('HLS_FRAGMENT_PLACEHOLDER'))}`, false);
    assert.equal(reason(result, 'HLS_FRAGMENT'), 'unsupported-syntax');
    assert.equal(result.effective.HLS_WINDOW, '30');
  });

  it('keeps harmless scalar-placeholder comments and a first quoted mapped occurrence supported', () => {
    const file = `# HLS_FRAGMENT_PLACEHOLDER\nvhost one { hls { hls_fragment "HLS_FRAGMENT_PLACEHOLDER"; # HLS_FRAGMENT_PLACEHOLDER\nhls_window 30; } }`;
    assert.deepEqual(observe(file, false).effective, { HLS_FRAGMENT: '7', HLS_WINDOW: '30' });
  });
});
