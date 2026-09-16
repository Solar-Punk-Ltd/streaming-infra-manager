import {
  type EngineSettings,
  engineSettingsFields,
  OME_SERVICE,
  SRS_SERVICE,
} from '@streaming-infra-manager/common';
import { string } from 'yup';

/**
 * Every engine setting key either engine reads, as an optional string.
 *
 * Built from the shared field list rather than written out, so a key added
 * there is accepted here without a second edit. The values stay strings because
 * that is what they are in an env file: coercing `1.50` to a number and back
 * would write a different line than the operator typed.
 *
 * A module of its own because two bodies carry these keys and the two schemas
 * cannot import each other. The settings route takes them at the top level of
 * its own body, and the create body takes them nested under `engine_settings`.
 */
export const ENGINE_SETTING_VALUE_FIELDS = Object.fromEntries(
  [...engineSettingsFields(SRS_SERVICE), ...engineSettingsFields(OME_SERVICE)]
    .map((field) => field.key)
    .map((key) => [key, string().notRequired()]),
);

/**
 * Drops the keys yup left as `undefined`.
 *
 * The schemas declare every known key so unknown ones are stripped, and yup
 * hands back the absent ones as `undefined`. Stored as they are, they would
 * become JSON nulls in the column and then values the engine tries to read.
 */
export function definedSettingValues(
  body: Record<string, unknown>,
): EngineSettings {
  const settings: EngineSettings = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') settings[key] = value;
  }
  return settings;
}
