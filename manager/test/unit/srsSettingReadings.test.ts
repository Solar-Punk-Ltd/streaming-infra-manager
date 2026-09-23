import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assembleEngineSettingObservations, effectiveEngineDefaults, engineSettingsFieldsFor, environmentSettingReadings,
  type EngineSettings,
} from '@streaming-infra-manager/common';
import { srsSettingReadings, srsTemplateReadings } from '../../src/domain/engineConfig/srsSettingReadings.js';

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

  for (const [placement, file] of [
    ['transcode inside HLS', config(engine('low'), 'hls { hls_fragment 4; hls_window 30;\nTRANSCODE_PLACEHOLDER\n}')],
    ['transcode at root', `${config(engine('low'))}\nTRANSCODE_PLACEHOLDER\n`],
    ['vhost inside a vhost', config(engine('low')).replace('transcode {', '\nABR_VHOST_PLACEHOLDER\ntranscode {')],
    ['transcode inside a nested vhost', `${config(engine('low'))}\nvhost outer { vhost inner {\nTRANSCODE_PLACEHOLDER\n} }`],
  ]) {
    it(`keeps ${placement} unverified when generation is enabled`, () => {
      const result = observe(file!);
      assert.deepEqual(result.effective, {});
      assert.equal(reason(result, 'HLS_FRAGMENT'), 'unsupported-syntax');
      assert.equal(reason(result, 'ABR_FPS'), 'unsupported-syntax');
    });

    it(`reads independent HLS when ${placement} is deleted with generation disabled`, () => {
      assert.deepEqual(observe(file!, false).effective, { HLS_FRAGMENT: '4', HLS_WINDOW: '30' });
    });
  }

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

/**
 * The SRT latency in a config file of the deployment's own.
 *
 * SRS 6 applies `latency` to both directions and then `recvlatency`, which it
 * falls back to 120 for when the block leaves it out, so `recvlatency` alone
 * decides how long SRS waits on ingest. Measured with libsrt 1.5.4 over
 * loopback on 2026-09-23: `latency 2000` without `recvlatency` negotiated 120 ms,
 * and with `recvlatency 2000` beside it, 2000.
 */
describe('the SRT latency in a config file of the deployment own', () => {
  /** The stack's template since a1b43f0a, where both directives take the setting. */
  const fixedTemplate = `srt_server {\nenabled on;\nlatency SRT_LATENCY_PLACEHOLDER;\nrecvlatency SRT_LATENCY_PLACEHOLDER;\ntlpktdrop on;\n}\n${template}`;
  /** The pinned v3.1 template, where only `latency` does. */
  const v31Template = `srt_server {\nenabled on;\nlatency SRT_LATENCY_PLACEHOLDER;\ntlpktdrop on;\n}\n${template}`;
  const srtServer = (...lines: string[]) => `srt_server {\nenabled on;\n${lines.join('\n')}\n}\n`;

  function observeLatency(file: string, options: { abr?: boolean; selectedTemplate?: string | null } = {}) {
    const abr = options.abr ?? false;
    const fields = engineSettingsFieldsFor('srs', { abr });
    return assembleEngineSettingObservations({
      fields, settings: { SRT_LATENCY: '3000' },
      defaults: effectiveEngineDefaults('srs'),
      readings: srsSettingReadings(options.selectedTemplate === undefined ? fixedTemplate : options.selectedTemplate, file, fields, { abr }),
    });
  }

  it('reads the deployment value where the file keeps the recvlatency placeholder', () => {
    const result = observeLatency(`${srtServer('latency SRT_LATENCY_PLACEHOLDER;', 'recvlatency SRT_LATENCY_PLACEHOLDER;')}${config()}`);

    assert.equal(result.effective.SRT_LATENCY, '3000');
    assert.equal(result.observations.SRT_LATENCY.source, 'deployment');
    assert.equal(result.observations.SRT_LATENCY.environment, 'all');
  });

  it('reads a recvlatency the file writes as a literal, whatever latency says', () => {
    const result = observeLatency(`${srtServer('latency 5000;', 'recvlatency 500;')}${config()}`);

    assert.equal(result.effective.SRT_LATENCY, '500');
    assert.equal(result.observations.SRT_LATENCY.source, 'config-file');
    assert.ok(result.notInConfig.includes('SRT_LATENCY'), 'an override cannot change a literal');
  });

  it("reports SRS's own 120 where the file sets latency and no recvlatency, because SRS ignores latency for ingest without it", () => {
    for (const latency of ['latency SRT_LATENCY_PLACEHOLDER;', 'latency 5000;']) {
      const result = observeLatency(`${srtServer(latency)}${config()}`);

      assert.deepEqual(result.observations.SRT_LATENCY, {
        status: 'known', source: 'built-in', value: '120', environment: 'none', reason: 'latency-without-recvlatency',
      }, latency);
      assert.equal(result.effective.SRT_LATENCY, '120');
      assert.ok(result.notInConfig.includes('SRT_LATENCY'), 'the override does not reach the wait on ingest');
    }
  });

  it("reports SRS's own 120 where the file sets neither", () => {
    const result = observeLatency(`${srtServer('tlpktdrop on;')}${config()}`);

    assert.deepEqual(result.observations.SRT_LATENCY, {
      status: 'known', source: 'built-in', value: '120', environment: 'none', reason: 'no-recvlatency',
    });
  });

  it("reads a copy of the pinned v3.1 template as SRS waiting its own 120, because that template fills only latency", () => {
    const result = observeLatency(v31Template, { selectedTemplate: v31Template });

    assert.equal(result.effective.SRT_LATENCY, '120');
    assert.equal(result.observations.SRT_LATENCY.source, 'built-in');
  });

  it('reads a recvlatency placeholder added against the v3.1 template, whose entrypoint fills every line', () => {
    const file = `${srtServer('latency SRT_LATENCY_PLACEHOLDER;', 'recvlatency SRT_LATENCY_PLACEHOLDER;')}${config()}`;
    const result = observeLatency(file, { selectedTemplate: v31Template });

    assert.equal(result.effective.SRT_LATENCY, '3000');
    assert.equal(result.observations.SRT_LATENCY.source, 'deployment');
  });

  it('refuses a line that carries the placeholder twice, in either order, because the entrypoint fills only the first', () => {
    for (const line of [
      'latency SRT_LATENCY_PLACEHOLDER; recvlatency SRT_LATENCY_PLACEHOLDER;',
      'recvlatency SRT_LATENCY_PLACEHOLDER; latency SRT_LATENCY_PLACEHOLDER;',
    ]) {
      const result = observeLatency(`${srtServer(line)}${config()}`);

      assert.deepEqual(result.observations.SRT_LATENCY, {
        status: 'unknown', source: 'unverified', value: null, reason: 'unsupported-syntax', environment: 'unknown',
      }, line);
    }
  });

  it('refuses to choose between two recvlatency directives', () => {
    const result = observeLatency(`${srtServer('recvlatency 500;', 'recvlatency 600;')}${config()}`);

    assert.equal(reason(result, 'SRT_LATENCY'), 'ambiguous-path');
  });

  it('calls a file without an srt_server block one that omits the setting', () => {
    const result = observeLatency(config());

    assert.equal(result.observations.SRT_LATENCY.source, 'omitted');
    assert.equal(result.effective.SRT_LATENCY, undefined);
  });

  it('is read the same way on a ladder, where the encoders and the ABR vhost are generated', () => {
    const file = `${srtServer('recvlatency SRT_LATENCY_PLACEHOLDER;')}${config(engine('low'))}\nABR_VHOST_PLACEHOLDER\n`;
    const result = observeLatency(file, { abr: true });

    assert.equal(result.effective.SRT_LATENCY, '3000');
    assert.equal(reason(result, 'HLS_FRAGMENT'), 'unsupported-syntax');
  });

  it('stays unverified without the version template, or with one that does not take the setting', () => {
    const file = `${srtServer('recvlatency SRT_LATENCY_PLACEHOLDER;')}${config()}`;

    assert.equal(reason(observeLatency(file, { selectedTemplate: null }), 'SRT_LATENCY'), 'metadata-unavailable');
    assert.equal(reason(observeLatency(file, { selectedTemplate: `srt_server { enabled on; }\n${template}` }), 'SRT_LATENCY'), 'metadata-unavailable');
  });
});

/**
 * A deployment with no config file of its own runs its version's template as
 * SRS's config, so its wait on ingest is read off that template. Every other
 * field reads as the environment there, because the template fills each from
 * it. v3.1's template fills only `latency`, which SRS ignores on ingest.
 */
describe('the SRT latency of a deployment that runs its version template', () => {
  const fields = engineSettingsFieldsFor('srs', { abr: false });
  const v31Template = `srt_server {\nenabled on;\nlatency SRT_LATENCY_PLACEHOLDER;\ntlpktdrop on;\n}\n${template}`;
  const fixedTemplate = `srt_server {\nenabled on;\nlatency SRT_LATENCY_PLACEHOLDER;\nrecvlatency SRT_LATENCY_PLACEHOLDER;\ntlpktdrop on;\n}\n${template}`;
  /** The `srt_server` block of stack tag v2 at 12632b50, whose entrypoint never reads the setting. */
  const v2Template = `srt_server {\nenabled on;\nlisten 10080;\nlatency 200;\npassphrase PASSPHRASE_PLACEHOLDER;\npbkeylen 16;\ntlpktdrop on;\ntsbpdmode on;\n}\n${template}`;

  it("reports SRS's own 120 for a template that fills only latency, as v3.1's does", () => {
    assert.deepEqual(srsTemplateReadings(v31Template, fields), {
      SRT_LATENCY: [{ kind: 'built-in', value: '120', reason: 'version-without-recvlatency' }],
    });
  });

  it('leaves the environment reading standing for a template that fills recvlatency', () => {
    assert.deepEqual(srsTemplateReadings(fixedTemplate, fields), {});
  });

  it('leaves it standing where the template cannot be read', () => {
    for (const unreadable of [null, 'vhost main {']) {
      assert.deepEqual(srsTemplateReadings(unreadable, fields), {}, String(unreadable));
    }
  });

  it("reports SRS's own 120 for a template that never takes the setting, as v2's writes latency 200 and no recvlatency", () => {
    for (const neverTakes of [v2Template, `srt_server { enabled on; }\n${template}`]) {
      assert.deepEqual(srsTemplateReadings(neverTakes, fields), {
        SRT_LATENCY: [{ kind: 'built-in', value: '120', reason: 'version-without-setting' }],
      }, neverTakes);
    }
  });

  it('reads the recvlatency such a template writes itself as the wait', () => {
    const writesItsOwn = v2Template.replace('latency 200;', 'latency 200;\nrecvlatency 800;');

    assert.deepEqual(srsTemplateReadings(writesItsOwn, fields), {
      SRT_LATENCY: [{ kind: 'built-in', value: '800', reason: 'version-without-setting' }],
    });
  });

  it('does not report a recvlatency the setting would refuse as the wait', () => {
    for (const value of ['5', 'soon']) {
      const writesItsOwn = v2Template.replace('latency 200;', `latency 200;\nrecvlatency ${value};`);

      assert.deepEqual(srsTemplateReadings(writesItsOwn, fields), {
        SRT_LATENCY: [{ kind: 'unverified', reason: 'invalid-scalar', environment: 'unknown' }],
      }, value);
    }
  });

  it('reads nothing for a field list that carries no SRT latency', () => {
    assert.deepEqual(srsTemplateReadings(v31Template, engineSettingsFieldsFor('ome', { abr: false })), {});
  });

  it('makes the stored value one SRS never applies, and leaves the other fields to the environment', () => {
    const result = assembleEngineSettingObservations({
      fields, settings: { SRT_LATENCY: '3000', HLS_WINDOW: '30' }, defaults: effectiveEngineDefaults('srs'),
      readings: { ...environmentSettingReadings(fields), ...srsTemplateReadings(v31Template, fields) },
    });

    assert.deepEqual(result.observations.SRT_LATENCY, {
      status: 'known', source: 'built-in', value: '120', environment: 'none', reason: 'version-without-recvlatency',
    });
    assert.equal(result.effective.HLS_WINDOW, '30');
    assert.deepEqual(result.notInConfig, ['SRT_LATENCY']);
  });

  it("shows neither a stored value nor the manager's 2000 as the wait on a version that never reads the setting", () => {
    const storedAndUnset: EngineSettings[] = [{ SRT_LATENCY: '3000' }, {}];
    for (const settings of storedAndUnset) {
      const result = assembleEngineSettingObservations({
        fields, settings, defaults: effectiveEngineDefaults('srs'),
        readings: { ...environmentSettingReadings(fields), ...srsTemplateReadings(v2Template, fields) },
      });

      assert.deepEqual(result.observations.SRT_LATENCY, {
        status: 'known', source: 'built-in', value: '120', environment: 'none', reason: 'version-without-setting',
      }, JSON.stringify(settings));
      assert.deepEqual(result.notInConfig, ['SRT_LATENCY']);
    }
  });
});
