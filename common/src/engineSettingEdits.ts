/**
 * A deployment's engine settings as a save of its settings page changes them.
 *
 * The page edits the engine settings in the same list as every other key, and
 * a save carries both kinds. The engine settings stay where they always were,
 * so the manager takes the engine keys out of a save and applies them to what
 * is stored, and the page works out the same result before it lets Save
 * through. Both judge it by the engine's own rules, from here.
 */
import type { DeploymentSettingEdit } from './deploymentSettings.js';
import {
  applicableEngineSettings,
  type EngineSettings,
  engineSettingFieldOf,
  engineSettingsProblem,
} from './engineSettings.js';
import type { EngineName } from './engines.js';

/** Whether a save names any engine setting, which is when the engine's rules judge what it leaves stored. */
export function editsEngineSettings(edits: readonly DeploymentSettingEdit[]): boolean {
  return edits.some(({ key }) => engineSettingFieldOf(key) !== null);
}

/**
 * The engine settings a save leaves stored: what is stored, each value the
 * save gives an engine key set, and each engine key it resets taken out. A key
 * that is no engine setting leaves them alone.
 */
export function engineSettingsAfterEdits(
  stored: EngineSettings,
  edits: readonly DeploymentSettingEdit[],
): EngineSettings {
  const next: EngineSettings = { ...stored };
  for (const { key, value } of edits) {
    if (engineSettingFieldOf(key) === null) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

export interface EngineSettingsSaveCheck {
  /** The deployment encodes the ABR ladder, so the rung settings apply and the keyframe rule with them. */
  abr: boolean;
  /** What each unset key falls back to on the deployment's host, which either half of a pair may be. */
  defaults: EngineSettings;
}

/**
 * Why the engine would refuse the engine settings a save leaves stored, in
 * the engine's own words, or null.
 *
 * Only the keys the deployment still reads are judged, because only those are
 * written at its deploy: a rung setting left behind when the ladder was turned
 * off applies to nothing, and refusing over it would refuse every save until
 * somebody found it.
 */
export function engineSettingsSaveProblem(
  engine: EngineName,
  settings: EngineSettings,
  check: EngineSettingsSaveCheck,
): string | null {
  return engineSettingsProblem(engine, applicableEngineSettings(engine, settings, check), check);
}
