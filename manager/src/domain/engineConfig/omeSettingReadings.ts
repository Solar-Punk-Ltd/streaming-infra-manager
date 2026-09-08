import {
  ENGINE_CONFIG_MAX_BYTES, type EngineSettingField, type EngineSettingReading, type EngineSettingReadings,
  type EngineSettingUnknownReason,
} from '@streaming-infra-manager/common';

import { parseOmeXml } from './omeXml.js';
import { prefixesOf, valuesByPath } from './omeXmlPaths.js';

const unverified = (reason: EngineSettingUnknownReason): EngineSettingReading => ({ kind: 'unverified', reason });

function parsedPaths(xml: string | null): Map<string, string[]> | null {
  if (xml === null || Buffer.byteLength(xml) > ENGINE_CONFIG_MAX_BYTES) return null;
  const parsed = parseOmeXml(xml);
  return parsed.problem === null && parsed.root.name === 'Server' ? valuesByPath(parsed.root) : null;
}

function readingAt(path: string, placeholder: string, template: Map<string, string[]>, file: Map<string, string[]>): EngineSettingReading {
  for (const prefix of prefixesOf(path)) {
    const expected = template.get(prefix)?.length ?? 0;
    const found = file.get(prefix)?.length ?? 0;
    if (expected !== 1 || found > 1) return unverified('ambiguous-path');
    if (prefix.endsWith(']') && ((template.get(`${prefix}/Name`)?.length ?? 0) !== 1 || (found && file.get(`${prefix}/Name`)?.length !== 1))) {
      return unverified('ambiguous-path');
    }
  }
  const values = file.get(path);
  if (!values?.length) return { kind: 'omitted' };
  if ([...file.keys()].some(candidate => candidate.startsWith(`${path}/`))) return unverified('invalid-scalar');
  return values[0] === placeholder ? { kind: 'environment' } : { kind: 'literal', value: values[0]! };
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
    const paths = [...template].filter(([, values]) => values.includes(field.placeholder!)).map(([path]) => path);
    return [field.key, paths.length
      ? paths.map(path => readingAt(path, field.placeholder!, template, file))
      : [unverified('metadata-unavailable')]];
  }));
}
