/**
 * The value a setting falls back to when a deployment does not store one, which
 * is not always the stack's own.
 *
 * `.env.<profile>` is a fresh copy of the stack's base `.env` on every deploy
 * and `engineSettingsEnv` leaves an unset key out of it on purpose, so a key
 * the host was configured with by hand is what the container starts with. A
 * drawer that names the stack's value there, and a keyframe rule computed with
 * it, both describe a deployment nobody is running.
 *
 * The manager reads the base env and calls this. The offline mock calls it with
 * its own stand-in for one, so the two answer the same shape from one rule.
 */
import type { EngineName } from './engines.js';
import {
  type EngineSettingField,
  type EngineSettings,
  engineSettingFieldProblem,
  engineSettingsFields,
} from './engineSettings.js';

/** Whether a default is the stack's own or one this host's base env sets. */
export type EngineDefaultSource = 'stack' | 'host';

/** The origin of every default, by setting key. */
export type EngineDefaultSources = Record<string, EngineDefaultSource>;

export interface EngineDefaults {
  /** Every key the engine reads, with the value an unset field falls back to. */
  values: EngineSettings;
  sources: EngineDefaultSources;
  /**
   * Keys the base env sets to something no field would accept, so the stack's
   * own value stands instead. Returned rather than logged here, because this
   * runs in the browser as well as in the manager.
   */
  rejected: readonly string[];
}

interface ChosenDefault {
  value: string;
  source: EngineDefaultSource;
  /** The host's value, when it is one the field would refuse. */
  refused: string | null;
}

function chooseDefault(
  field: EngineSettingField,
  hostValue: string | undefined,
): ChosenDefault {
  const value = hostValue?.trim();
  if (!value) {
    return { value: field.defaultValue, source: 'stack', refused: null };
  }
  if (engineSettingFieldProblem(field, value)) {
    return { value: field.defaultValue, source: 'stack', refused: value };
  }
  return { value, source: 'host', refused: null };
}

/** What every setting of one engine falls back to on the host this base env came from. */
export function effectiveEngineDefaults(
  engine: EngineName,
  baseEnv: Record<string, string> = {},
): EngineDefaults {
  const values: EngineSettings = {};
  const sources: EngineDefaultSources = {};
  const rejected: string[] = [];

  for (const field of engineSettingsFields(engine)) {
    const chosen = chooseDefault(field, baseEnv[field.key]);
    values[field.key] = chosen.value;
    sources[field.key] = chosen.source;
    if (chosen.refused !== null) rejected.push(field.key);
  }

  return { values, sources, rejected };
}
