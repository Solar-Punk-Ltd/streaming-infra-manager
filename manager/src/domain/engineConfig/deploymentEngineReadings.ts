import {
  type EngineName,
  type EngineSettingField,
  type EngineSettingReadings,
  environmentSettingReadings,
  OME_SERVICE,
  SRS_SERVICE,
} from '@streaming-infra-manager/common';

import { omeSettingReadings } from './omeSettingReadings.js';
import { srsSettingReadings, srsTemplateReadings } from './srsSettingReadings.js';

/** The config a deployment's engine settings are read against. */
export interface EngineConfigTexts {
  /** The version's template, or null where it could not be read. */
  template: string | null;
  /** Whether the deployment runs a config file of its own rather than the version's template. */
  hasOwn: boolean;
  /** That file as stored, or null where it could not be read, which reads as unknown rather than as the template. */
  own: string | null;
}

/**
 * How the config a deployment's engine runs takes each of its settings, which
 * is what says a setting is no longer read.
 *
 * A config file of the deployment's own is read as it stands. Without one the
 * deployment runs its version's template, which fills every setting from the
 * environment except, on SRS, the SRT latency, whose wait on ingest the
 * template can decide itself. The Engine card, a deployment's settings list and
 * the offline mock all read it here.
 */
export function deploymentEngineReadings(
  engine: EngineName,
  fields: readonly EngineSettingField[],
  config: EngineConfigTexts,
  options: { abr: boolean },
): EngineSettingReadings {
  if (config.hasOwn) {
    return engine === OME_SERVICE
      ? omeSettingReadings(config.template, config.own, fields)
      : srsSettingReadings(config.template, config.own, fields, options);
  }
  const environment = environmentSettingReadings(fields);
  return engine === SRS_SERVICE ? { ...environment, ...srsTemplateReadings(config.template, fields) } : environment;
}
