import type { EngineDefaults } from './engineDefaults.js';
import { engineSettingFieldProblem, type EngineSettingField, type EngineSettings } from './engineSettings.js';

export type EngineSettingEnvironment = 'all' | 'none' | 'partial' | 'unknown';
export type EngineSettingUnknownReason = 'missing-directive' | 'conflicting-values' | 'mixed-sources'
  | 'ambiguous-path' | 'unsupported-syntax' | 'invalid-scalar' | 'metadata-unavailable'
  | 'not-applicable' | 'mixed-applicability' | 'codec-unverified';

export type EngineSettingObservation =
  | { status: 'known'; source: 'deployment' | 'host' | 'stack' | 'config-file'; value: string; environment: EngineSettingEnvironment }
  | { status: 'unknown'; source: 'omitted' | 'unverified'; value: null; reason: EngineSettingUnknownReason; environment: EngineSettingEnvironment };

export type EngineSettingObservations = Record<string, EngineSettingObservation>;

export type EngineSettingReading =
  | { kind: 'environment' }
  | { kind: 'literal'; value: string }
  | { kind: 'omitted' }
  | { kind: 'unverified'; reason: EngineSettingUnknownReason; environment?: EngineSettingEnvironment };

/** One reading per required occurrence, so a missing application cannot be hidden by another. */
export type EngineSettingReadings = Readonly<Record<string, readonly EngineSettingReading[]>>;

export interface EngineSettingObservationInput {
  fields: readonly EngineSettingField[];
  settings: EngineSettings;
  defaults: EngineDefaults;
  readings: EngineSettingReadings;
}

export interface EngineSettingObservationResult {
  observations: EngineSettingObservations;
  effective: EngineSettings;
  notInConfig: string[];
}

/** Use only where the selected startup contract proves environment-based settings. */
export function environmentSettingReadings(fields: readonly EngineSettingField[]): EngineSettingReadings {
  return Object.fromEntries(fields.map(field => [field.key, [{ kind: 'environment' }]]));
}

function environmentOf(readings: readonly EngineSettingReading[]): EngineSettingEnvironment {
  if (!readings.length) return 'unknown';
  const sources = readings.map(reading => reading.kind === 'environment' ? 'all'
    : reading.kind === 'unverified' ? reading.environment ?? 'unknown' : 'none');
  if (sources.includes('unknown')) return 'unknown';
  if (sources.every(source => source === 'all')) return 'all';
  if (sources.every(source => source === 'none')) return 'none';
  return 'partial';
}

function observeField(field: EngineSettingField, input: EngineSettingObservationInput): EngineSettingObservation {
  const readings = input.readings[field.key] ?? [];
  const environment = environmentOf(readings);
  const unknown = (reason: EngineSettingUnknownReason, source: 'omitted' | 'unverified' = 'unverified'): EngineSettingObservation =>
    ({ status: 'unknown', source, value: null, reason, environment });
  if (!readings.length) return unknown('metadata-unavailable');
  const unverified = readings.find(reading => reading.kind === 'unverified');
  if (unverified?.kind === 'unverified') return unknown(unverified.reason);
  if (readings.some(reading => reading.kind === 'omitted')) return unknown('missing-directive', 'omitted');
  if (readings.some(reading => reading.kind === 'literal') && readings.some(reading => reading.kind === 'environment')) {
    return unknown('mixed-sources');
  }
  const literals = readings.filter(reading => reading.kind === 'literal');
  if (literals.length) {
    const values = literals.map(reading => reading.value.trim());
    if (values.some(value => engineSettingFieldProblem(field, value) !== null)) return unknown('invalid-scalar');
    if (values.some(value => value !== values[0])) return unknown('conflicting-values');
    return { status: 'known', source: 'config-file', value: values[0]!, environment };
  }
  const stored = input.settings[field.key]?.trim();
  const value = stored || input.defaults.values[field.key];
  const source = stored ? 'deployment' : input.defaults.sources[field.key];
  if (value === undefined || source === undefined) return unknown('metadata-unavailable');
  if (engineSettingFieldProblem(field, value) !== null) return unknown('invalid-scalar');
  return { status: 'known', source, value, environment };
}

/** The observation map is the only authority for effective values and environment applicability. */
export function assembleEngineSettingObservations(input: EngineSettingObservationInput): EngineSettingObservationResult {
  const observations: EngineSettingObservations = {};
  const effective: EngineSettings = {};
  const notInConfig: string[] = [];
  for (const field of input.fields) {
    const observation = observeField(field, input);
    observations[field.key] = observation;
    if (observation.status === 'known') effective[field.key] = observation.value;
    if (observation.environment === 'none') notInConfig.push(field.key);
  }
  return { observations, effective, notInConfig };
}
