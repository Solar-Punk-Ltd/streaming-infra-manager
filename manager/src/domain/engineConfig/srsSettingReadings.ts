import {
  engineSettingFieldProblem,
  type EngineSettingField, type EngineSettingReading, type EngineSettingReadings, type EngineSettingUnknownReason,
} from '@streaming-infra-manager/common';

import { parseSrsConfig, type SrsDirective } from './srsConfigSyntax.js';

interface Entry {
  node: SrsDirective;
  ancestry: readonly SrsDirective[];
  unique: boolean;
}

/** The field whose config directive is stated in a different unit than the field. */
const SEGMENT_MAX_KEY = 'HLS_SEGMENT_MAX';
const HLS_DIRECTIVES: Record<string, string> = { HLS_FRAGMENT: 'hls_fragment', HLS_WINDOW: 'hls_window', [SEGMENT_MAX_KEY]: 'hls_aof_ratio' };
/**
 * The SRT latency, read as the wait SRS applies to a broadcast it receives.
 *
 * SRS 6 applies `latency` to both directions and `recvlatency` after it, and
 * falls back to 120 for `recvlatency` when the block leaves it out, so
 * `recvlatency` alone decides the wait on ingest. Read from SRS 6.0's
 * `set_srt_opt` and `get_srto_recv_latency`, and measured with libsrt 1.5.4
 * on 2026-09-23: `latency 2000` without `recvlatency` negotiated 120 ms. The
 * `srt_server` block sits outside every vhost, the generated ABR vhost
 * included, so that vhost hides neither directive.
 */
const SRT_LATENCY_KEY = 'SRT_LATENCY';
const INGEST_LATENCY_DIRECTIVE = 'recvlatency';
const BOTH_WAYS_LATENCY_DIRECTIVE = 'latency';
const SRS_INGEST_LATENCY_DEFAULT_MS = '120';
const SRT_SERVER_SCOPE = ['srt_server'];

/** The scopes of a file to read a field in, or the one reading that says why there are none. */
type FieldScopes = { scopes: Entry[] } | { reading: EngineSettingReading };
const ENCODER_DIRECTIVES: Record<string, string> = {
  ABR_FPS: 'vfps', ABR_PRESET: 'vpreset', ABR_PROFILE: 'vprofile', ABR_THREADS: 'vthreads', ABR_ACODEC: 'acodec',
};
const ENCODER_SCOPE = ['vhost', 'transcode', 'engine'];
const unknown = (reason: EngineSettingUnknownReason, environment: 'none' | 'unknown' = 'unknown'): EngineSettingReading =>
  ({ kind: 'unverified', reason, environment });

function entriesIn(nodes: readonly SrsDirective[], ancestors: readonly SrsDirective[] = [], parentsUnique = true): Entry[] {
  const entries: Entry[] = [];
  for (const node of nodes) {
    const matches = nodes.filter(other => other.name === node.name && JSON.stringify(other.args) === JSON.stringify(node.args));
    const unique = parentsUnique && matches.length === 1;
    const ancestry = [...ancestors, node];
    entries.push({ node, ancestry, unique });
    if (node.children) entries.push(...entriesIn(node.children, ancestry, unique));
  }
  return entries;
}

function scopeNames(entry: Entry): string[] { return entry.ancestry.map(node => node.name); }

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function validScope(entry: Entry): boolean {
  return entry.unique && entry.ancestry.every(node =>
    node.name === 'vhost' || node.name === 'engine' ? node.args.length === 1
      : node.name === 'transcode' ? node.args.length <= 1 : node.args.length === 0);
}

function supportedGenerationScope(entry: Entry): boolean {
  return validScope(entry) && (entry.node.name === 'ABR_VHOST_PLACEHOLDER'
    ? entry.ancestry.length === 1
    : sameNames(scopeNames(entry), ['vhost', 'TRANSCODE_PLACEHOLDER']));
}

function scalarIn(scope: Entry, directive: string, placeholder?: string, source?: string): EngineSettingReading {
  if (!validScope(scope)) return unknown('ambiguous-path');
  const values = scope.node.children?.filter(node => node.name === directive) ?? [];
  if (values.length > 1) return unknown('ambiguous-path');
  if (!values.length) return { kind: 'omitted' };
  const value = values[0]!;
  if (value.children !== null || value.args.length !== 1) return unknown('invalid-scalar');
  if (placeholder !== undefined && value.args[0] === placeholder) {
    if (source === undefined) return unknown('metadata-unavailable');
    const offset = value.argOffsets[0]!;
    const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
    // The pinned entrypoint's HLS substitutions have no g flag.
    return source.indexOf(placeholder, lineStart) === offset ? { kind: 'environment' } : unknown('unsupported-syntax');
  }
  return { kind: 'literal', value: value.args[0]! };
}

function hasIncludeFor(entries: readonly Entry[], patterns: readonly (readonly string[])[]): boolean {
  return entries.some(entry => {
    if (entry.node.name !== 'include') return false;
    const parent = scopeNames(entry).slice(0, -1);
    return patterns.some(pattern => parent.length <= pattern.length && parent.every((name, index) => name === pattern[index]));
  });
}

/** Every scope of the file matching one where the version's template fills the field's placeholder into one of `directives`. */
function scopesFilledIn(field: EngineSettingField, directives: readonly string[], template: readonly Entry[] | null, file: readonly Entry[]): FieldScopes {
  if (template === null || !field.placeholder) return { reading: unknown('metadata-unavailable') };
  const required = template.filter(entry => directives.includes(entry.node.name)
    && entry.node.children === null && entry.node.args.length === 1 && entry.node.args[0] === field.placeholder);
  if (!required.length) return { reading: unknown('metadata-unavailable') };
  if (required.some(entry => !entry.unique)) return { reading: unknown('ambiguous-path') };
  const patterns = required.map(entry => scopeNames(entry).slice(0, -1));
  if (hasIncludeFor(file, patterns)) return { reading: unknown('unsupported-syntax') };
  const scopes = file.filter(entry => entry.node.children !== null && patterns.some(pattern => sameNames(scopeNames(entry), pattern)));
  if (!scopes.length) return { reading: { kind: 'omitted' } };
  return { scopes };
}

/** One scalar directive, in every scope of the file where the version's template fills it with the field's placeholder. */
function placeholderDirectiveReadings(field: EngineSettingField, directive: string, template: readonly Entry[] | null, file: readonly Entry[], source: string): EngineSettingReading[] {
  const found = scopesFilledIn(field, [directive], template, file);
  if ('reading' in found) return [found.reading];
  return found.scopes.map(scope => scalarIn(scope, directive, field.placeholder, source));
}

/** The wait on ingest in one `srt_server` block, which is SRS's own 120 where the block sets no `recvlatency`. */
function ingestLatencyIn(scope: Entry, placeholder: string | undefined, source: string): EngineSettingReading {
  const reading = scalarIn(scope, INGEST_LATENCY_DIRECTIVE, placeholder, source);
  if (reading.kind !== 'omitted') return reading;
  const setsLatency = scope.node.children?.some(node => node.name === BOTH_WAYS_LATENCY_DIRECTIVE) ?? false;
  return {
    kind: 'built-in',
    value: SRS_INGEST_LATENCY_DEFAULT_MS,
    reason: setsLatency ? 'latency-without-recvlatency' : 'no-recvlatency',
  };
}

/**
 * Whether a line of the file carries the placeholder more than once. The
 * entrypoint's substitution has no g flag, so it fills the first on each line
 * and hands SRS the rest as the token itself.
 */
function repeatsOnALine(source: string, placeholder: string): boolean {
  return source.split('\n').some(line => line.indexOf(placeholder) !== line.lastIndexOf(placeholder));
}

/**
 * The SRT latency, anchored wherever the version's template puts the
 * placeholder: `latency` alone on v3.1, both directives since the stack's
 * a1b43f0a. Both sit in `srt_server`.
 */
function srtLatencyReadings(field: EngineSettingField, template: readonly Entry[] | null, file: readonly Entry[], source: string): EngineSettingReading[] {
  const found = scopesFilledIn(field, [BOTH_WAYS_LATENCY_DIRECTIVE, INGEST_LATENCY_DIRECTIVE], template, file);
  if ('reading' in found) return [found.reading];
  if (field.placeholder && repeatsOnALine(source, field.placeholder)) return [unknown('unsupported-syntax')];
  return found.scopes.map(scope => ingestLatencyIn(scope, field.placeholder, source));
}

function hlsReadings(field: EngineSettingField, template: readonly Entry[] | null, file: readonly Entry[], opaqueVhost: boolean, source: string): EngineSettingReading[] {
  if (opaqueVhost) return [unknown('unsupported-syntax')];
  return placeholderDirectiveReadings(field, HLS_DIRECTIVES[field.key]!, template, file, source);
}

function bitrateReadings(scopes: readonly Entry[]): EngineSettingReading[] {
  const codecs = scopes.map(scope => scalarIn(scope, 'acodec'));
  if (codecs.some(codec => codec.kind !== 'literal' || !['copy', 'aac'].includes(codec.value))) return [unknown('codec-unverified')];
  const values = codecs.map(codec => codec.kind === 'literal' ? codec.value : '');
  if (values.every(value => value === 'copy')) return [unknown('not-applicable', 'none')];
  if (values.some(value => value === 'copy')) return [unknown('mixed-applicability')];
  return scopes.map(scope => scalarIn(scope, 'abitrate'));
}

/** Read configured scalar evidence, including disabled scopes conservatively, without claiming runtime activation. */
export function srsSettingReadings(
  templateText: string | null,
  fileText: string | null,
  fields: readonly EngineSettingField[],
  options: { abr: boolean },
): EngineSettingReadings {
  const parsedFile = parseSrsConfig(fileText);
  if (parsedFile === null) return Object.fromEntries(fields.map(field => [field.key, [unknown(fileText === null ? 'metadata-unavailable' : 'unsupported-syntax')]]));
  const parsedTemplate = parseSrsConfig(templateText);
  const template = parsedTemplate === null ? null : entriesIn(parsedTemplate);
  const file = entriesIn(parsedFile);
  if (options.abr && file.some(entry => entry.node.generated && !supportedGenerationScope(entry))) {
    return Object.fromEntries(fields.map(field => [field.key, [unknown('unsupported-syntax')]]));
  }
  const activeMarker = (name: string) => options.abr && file.some(entry => entry.node.generated && entry.node.name === name);
  const opaqueVhost = activeMarker('ABR_VHOST_PLACEHOLDER');
  const opaqueEncoder = activeMarker('TRANSCODE_PLACEHOLDER') || hasIncludeFor(file, [ENCODER_SCOPE]);
  const encoders = file.filter(entry => entry.node.children !== null && sameNames(scopeNames(entry), ENCODER_SCOPE));
  return Object.fromEntries(fields.map(field => {
    if (field.key in HLS_DIRECTIVES) {
      const readings = hlsReadings(field, template, file, opaqueVhost, fileText ?? '');
      // `hls_aof_ratio` is a multiple of `hls_fragment`, and the field is the
      // seconds the entrypoint derives that multiple from. A config that writes
      // a number there rather than the token is therefore not stating this
      // setting, and reading it back would report a ratio as a duration.
      return [field.key, field.key === SEGMENT_MAX_KEY
        ? readings.map(reading => reading.kind === 'literal' ? unknown('unsupported-syntax') : reading)
        : readings];
    }
    if (field.key === SRT_LATENCY_KEY) return [field.key, srtLatencyReadings(field, template, file, fileText ?? '')];
    if (field.key === 'ABR_VBV_SECONDS' || opaqueEncoder) return [field.key, [unknown('unsupported-syntax')]];
    if (!encoders.length) return [field.key, [{ kind: 'omitted' }]];
    if (field.key === 'ABR_AUDIO_BITRATE') return [field.key, bitrateReadings(encoders)];
    const directive = ENCODER_DIRECTIVES[field.key];
    return [field.key, directive ? encoders.map(scope => scalarIn(scope, directive)) : [unknown('metadata-unavailable')]];
  }));
}

function takesPlaceholder(entries: readonly Entry[], placeholder: string): boolean {
  return entries.some(entry => entry.node.args.some(arg => arg.includes(placeholder)));
}

const fixedByVersion = (value: string): EngineSettingReading => ({ kind: 'built-in', value, reason: 'version-without-setting' });

/**
 * The wait on ingest of a template that never takes the setting: the
 * `recvlatency` its `srt_server` block writes, or SRS's own 120 where it
 * writes none. Null for a template that runs no SRT server.
 */
function ingestLatencyFixedBy(field: EngineSettingField, template: readonly Entry[]): EngineSettingReading[] | null {
  const blocks = template.filter(entry => entry.node.children !== null && sameNames(scopeNames(entry), SRT_SERVER_SCOPE));
  if (!blocks.length) return null;
  if (hasIncludeFor(template, [SRT_SERVER_SCOPE])) return [unknown('unsupported-syntax')];
  return blocks.map(block => {
    const reading = scalarIn(block, INGEST_LATENCY_DIRECTIVE);
    if (reading.kind === 'omitted') return fixedByVersion(SRS_INGEST_LATENCY_DEFAULT_MS);
    if (reading.kind !== 'literal') return reading;
    return engineSettingFieldProblem(field, reading.value) === null ? fixedByVersion(reading.value.trim()) : unknown('invalid-scalar');
  });
}

/**
 * The readings a version's own template decides for a deployment with no
 * config file of its own, which runs that template as SRS's config. Merged over
 * the environment readings, which stand for every field the template fills
 * from the environment and for whatever this cannot decide.
 *
 * Only the SRT latency can come out otherwise. A template that fills only
 * `latency`, as v3's and v3.1's do, leaves SRS on its own 120 on ingest
 * whatever the setting says. One that fills `recvlatency` hands SRS the
 * setting, which is the environment reading. One that never takes the setting,
 * as v1's and v2's, which write `latency 200` themselves and whose entrypoints
 * never read the key, holds the wait at the `recvlatency` it writes, or at
 * SRS's own 120 where it writes none.
 */
export function srsTemplateReadings(
  templateText: string | null,
  fields: readonly EngineSettingField[],
): EngineSettingReadings {
  const field = fields.find(candidate => candidate.key === SRT_LATENCY_KEY);
  const parsed = parseSrsConfig(templateText);
  if (!field?.placeholder || parsed === null) return {};
  const template = entriesIn(parsed);
  if (!takesPlaceholder(template, field.placeholder)) {
    const fixed = ingestLatencyFixedBy(field, template);
    return fixed ? { [field.key]: fixed } : {};
  }
  const readings = srtLatencyReadings(field, template, template, templateText ?? '');
  const onlyLatency = readings.length === 1
    && readings[0]?.kind === 'built-in' && readings[0].reason === 'latency-without-recvlatency';
  if (!onlyLatency) return {};
  return { [field.key]: [{ kind: 'built-in', value: SRS_INGEST_LATENCY_DEFAULT_MS, reason: 'version-without-recvlatency' }] };
}
