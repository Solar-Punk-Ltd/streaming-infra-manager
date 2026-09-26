import { number, object, string, InferType } from 'yup';

import { ALL_SERVICES } from '../types/index.js';

import { ENGINE_SETTING_VALUE_FIELDS } from './engineSettingValues.js';
import { profileNameSchema } from './profile.js';

/** Names the keys and never a value, which a script can put anything in. */
function unknownEngineSettingMessage({ unknown }: { unknown: string }): string {
  return (
    `Not an engine setting either engine reads: ${unknown}. Nothing was stored. This route replaces every engine ` +
    'setting with the body, so a misspelled key would have put the setting it meant back to its default. ' +
    'GET /profiles/:name/engine lists the settings this deployment reads.'
  );
}

// The body replaces the whole set, so a key neither engine reads is refused
// rather than dropped: dropped, it reads as the setting it meant going back to
// its default. The route reads the body without dropping unknown keys, so this
// fires. A known key of the other engine is checked again by
// engineSettingsProblem, which names the engine that does not read it. The
// bounds, the choices and the keyframe rule are deliberately not here:
// engineSettingsProblem owns them, the settings page, its save and the deploy
// all call it, and a yup copy would be one more rule to keep in step.
export const engineSettingsSchema = object({
  ...ENGINE_SETTING_VALUE_FIELDS,
  expectedInstanceId: string().optional().strict().uuid('expectedInstanceId must be a deployment instance UUID'),
}).noUnknown(true, unknownEngineSettingMessage);

export type EngineSettingsBody = InferType<typeof engineSettingsSchema>;

/** `:name` and `:service` together, for the container routes. */
export const containerParamsSchema = profileNameSchema.concat(
  object({
    service: string()
      .required()
      .oneOf([...ALL_SERVICES], 'service must be one of this stack'),
  }).strict(),
);

export const logsQuerySchema = object({
  tail: number()
    .notRequired()
    .integer('tail must be a whole number of lines')
    .min(1, 'tail must be at least 1 line')
    .max(2000, 'tail must be at most 2000 lines'),
}).noUnknown(true);

export type LogsQuery = InferType<typeof logsQuerySchema>;
