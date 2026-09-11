import {
  ENGINE_CONFIG_MAX_BYTES, type EngineSettingField, type EngineSettingReading, type EngineSettingReadings,
  type EngineSettingUnknownReason,
} from '@streaming-infra-manager/common';

import { parseOmeXml } from './omeXml.js';
import { elementsWithPaths, type OmePathEntry, prefixesOf, valuesByPath } from './omeXmlPaths.js';

const unverified = (reason: EngineSettingUnknownReason): EngineSettingReading => ({ kind: 'unverified', reason });

interface ParsedPaths {
  values: Map<string, string[]>;
  entries: readonly OmePathEntry[];
}

function parsedPaths(xml: string | null): ParsedPaths | null {
  if (xml === null || Buffer.byteLength(xml) > ENGINE_CONFIG_MAX_BYTES) return null;
  const parsed = parseOmeXml(xml);
  return parsed.problem === null && parsed.root.name === 'Server'
    ? { values: valuesByPath(parsed.root), entries: [...elementsWithPaths(parsed.root)] } : null;
}

function readingAt(path: string, placeholder: string, template: Map<string, string[]>, file: Map<string, string[]>, templatePath = path): EngineSettingReading {
  const templatePrefixes = prefixesOf(templatePath);
  const filePrefixes = prefixesOf(path);
  if (templatePrefixes.length !== filePrefixes.length) return unverified('ambiguous-path');
  for (const [index, prefix] of filePrefixes.entries()) {
    const expectedPrefix = templatePrefixes[index]!;
    const expected = template.get(expectedPrefix)?.length ?? 0;
    const found = file.get(prefix)?.length ?? 0;
    if (expected !== 1 || found > 1) return unverified('ambiguous-path');
    if (prefix.endsWith(']') && ((template.get(`${expectedPrefix}/Name`)?.length ?? 0) !== 1 || (found && file.get(`${prefix}/Name`)?.length !== 1))) {
      return unverified('ambiguous-path');
    }
  }
  const values = file.get(path);
  if (!values?.length) return { kind: 'omitted' };
  if ([...file.keys()].some(candidate => candidate.startsWith(`${path}/`))) return unverified('invalid-scalar');
  return values[0] === placeholder ? { kind: 'environment' } : { kind: 'literal', value: values[0]! };
}

function matchesApplicationScope(scope: OmePathEntry, setting: OmePathEntry): boolean {
  const requiredAncestry = setting.ancestry.slice(0, -1);
  if (scope.ancestry.length !== requiredAncestry.length) return false;
  return scope.ancestry.every((element, index) => {
    const required = requiredAncestry[index]!;
    if (element.name !== required.name) return false;
    if (element.name === 'Application') return true;
    return element.children.find(child => child.name === 'Name')?.text
      === required.children.find(child => child.name === 'Name')?.text;
  });
}

function readingsAcrossApplications(placeholder: string, template: ParsedPaths, file: ParsedPaths): EngineSettingReading[] {
  const required = template.entries.filter(entry => entry.element.text === placeholder);
  if (!required.length) return [unverified('metadata-unavailable')];
  const requiredPaths = new Set(required.map(entry => entry.path));
  const readings = [...requiredPaths].map(path => readingAt(path, placeholder, template.values, file.values));
  const additional = new Map<string, string>();
  for (const scope of file.entries) {
    for (const setting of required) {
      if (!matchesApplicationScope(scope, setting)) continue;
      const path = `${scope.path}/${setting.element.name}`;
      if (!requiredPaths.has(path)) additional.set(path, setting.path);
    }
  }
  for (const [path, templatePath] of additional) {
    readings.push(readingAt(path, placeholder, template.values, file.values, templatePath));
  }
  return readings;
}

/** Observe mapped leaves without changing T03's independent config-admission rules. */
export function omeSettingReadings(templateXml: string | null, fileXml: string | null, fields: readonly EngineSettingField[]): EngineSettingReadings {
  const template = parsedPaths(templateXml);
  const file = parsedPaths(fileXml);
  return Object.fromEntries(fields.map(field => {
    // ee99c36 deploy/docker-compose.yml passes this to createOmeEngineFromEnv independently of Server.xml.
    if (field.key === 'OME_HLS_POLL_INTERVAL_MS') return [field.key, [{ kind: 'environment' }]];
    if (!template) return [field.key, [unverified('metadata-unavailable')]];
    if (!file) return [field.key, [unverified(fileXml === null ? 'metadata-unavailable' : 'unsupported-syntax')]];
    if (!field.placeholder) return [field.key, [unverified('metadata-unavailable')]];
    return [field.key, readingsAcrossApplications(field.placeholder, template, file)];
  }));
}
