import { number, object, string, InferType } from 'yup';

import { ALL_SERVICES } from '../types/index.js';

import { ENGINE_SETTING_VALUE_FIELDS } from './engineSettingValues.js';
import { profileNameSchema } from './profile.js';

// noUnknown strips a key neither engine reads, so a stale drawer cannot store
// one. Anything it lets through is checked again by engineSettingsProblem,
// which names the engine that does not read it. The bounds, the choices and
// the keyframe rule are deliberately not here: engineSettingsProblem owns them,
// the drawer and the deploy both call it, and a yup copy would be a third rule
// to keep in step.
export const engineSettingsSchema = object({
  ...ENGINE_SETTING_VALUE_FIELDS,
  expectedInstanceId: string().optional().strict().uuid('expectedInstanceId must be a deployment instance UUID'),
}).noUnknown(true);

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
