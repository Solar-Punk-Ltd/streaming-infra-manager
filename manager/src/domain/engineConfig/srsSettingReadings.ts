import type {
  EngineSettingField, EngineSettingReading, EngineSettingReadings, EngineSettingUnknownReason,
} from '@streaming-infra-manager/common';

import { parseSrsConfig, type SrsDirective } from './srsConfigSyntax.js';

interface Entry {
  node: SrsDirective;
  ancestry: readonly SrsDirective[];
  unique: boolean;
}

const HLS_DIRECTIVES: Record<string, string> = { HLS_FRAGMENT: 'hls_fragment', HLS_WINDOW: 'hls_window' };
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

function hlsReadings(field: EngineSettingField, template: readonly Entry[] | null, file: readonly Entry[], opaqueVhost: boolean, source: string): EngineSettingReading[] {
  if (opaqueVhost) return [unknown('unsupported-syntax')];
  if (template === null || !field.placeholder) return [unknown('metadata-unavailable')];
  const required = template.filter(entry => entry.node.name === HLS_DIRECTIVES[field.key]
    && entry.node.children === null && entry.node.args.length === 1 && entry.node.args[0] === field.placeholder);
  if (!required.length) return [unknown('metadata-unavailable')];
  if (required.some(entry => !entry.unique)) return [unknown('ambiguous-path')];
  const patterns = required.map(entry => scopeNames(entry).slice(0, -1));
  if (hasIncludeFor(file, patterns)) return [unknown('unsupported-syntax')];
  const scopes = file.filter(entry => entry.node.children !== null && patterns.some(pattern => sameNames(scopeNames(entry), pattern)));
  if (!scopes.length) return [{ kind: 'omitted' }];
  return scopes.map(scope => scalarIn(scope, HLS_DIRECTIVES[field.key]!, field.placeholder, source));
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
  const activeMarker = (name: string) => options.abr && file.some(entry => entry.node.generated && entry.node.name === name);
  const opaqueVhost = activeMarker('ABR_VHOST_PLACEHOLDER');
  const opaqueEncoder = activeMarker('TRANSCODE_PLACEHOLDER') || hasIncludeFor(file, [ENCODER_SCOPE]);
  const encoders = file.filter(entry => entry.node.children !== null && sameNames(scopeNames(entry), ENCODER_SCOPE));
  return Object.fromEntries(fields.map(field => {
    if (field.key in HLS_DIRECTIVES) return [field.key, hlsReadings(field, template, file, opaqueVhost, fileText ?? '')];
    if (field.key === 'ABR_VBV_SECONDS' || opaqueEncoder) return [field.key, [unknown('unsupported-syntax')]];
    if (!encoders.length) return [field.key, [{ kind: 'omitted' }]];
    if (field.key === 'ABR_AUDIO_BITRATE') return [field.key, bitrateReadings(encoders)];
    const directive = ENCODER_DIRECTIVES[field.key];
    return [field.key, directive ? encoders.map(scope => scalarIn(scope, directive)) : [unknown('metadata-unavailable')]];
  }));
}
