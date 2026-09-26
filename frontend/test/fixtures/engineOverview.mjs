/**
 * An SRS deployment's engine overview as the manager answers it, for the
 * offline pages. It is built from the deployment's row with the manager's own
 * shared rules: the identity the page checks it against, the fields it reads,
 * what each unset one falls back to on the host, and what each is observed
 * as. The config is the version's template, which reads every field.
 */
import {
  assembleEngineSettingObservations,
  effectiveEngineDefaults,
  engineOverviewIdentity,
  engineSettingsFieldsFor,
  environmentSettingReadings,
} from '@streaming-infra-manager/common';

/**
 * @param {object} profile the deployment's row as `GET /profiles` answers it
 * @param {object} [options]
 * @param {Record<string, string>} [options.hostEnv] what the host's base `.env` sets
 * @param {string[]} [options.without] keys the version does not offer
 */
export function srsOverviewOf(profile, { hostEnv = {}, without = [] } = {}) {
  const fields = engineSettingsFieldsFor('srs', { abr: false }).filter((field) => !without.includes(field.key));
  const defaults = effectiveEngineDefaults('srs', hostEnv, {});
  return {
    identity: engineOverviewIdentity(profile), engine: 'srs', abr: false, fields,
    settings: profile.engine_settings, defaults: defaults.values, defaultSources: defaults.sources,
    ...assembleEngineSettingObservations({ fields, settings: profile.engine_settings, defaults, readings: environmentSettingReadings(fields) }),
    live: null, liveUnavailableReason: 'Live engine status is not observed in this offline fixture.',
  };
}
