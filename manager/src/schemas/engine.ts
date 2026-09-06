import {
  engineSettingsFields,
  OME_SERVICE,
  SRS_SERVICE,
} from '@streaming-infra-manager/common';
import { number, object, string, InferType } from 'yup';

import { ALL_SERVICES } from '../types/index.js';

import { profileNameSchema } from './profile.js';

/**
 * Every engine setting key either engine reads, as an optional string.
 *
 * Built from the shared field list rather than written out, so a key added
 * there is accepted here without a second edit. The values stay strings because
 * that is what they are in an env file: coercing `1.50` to a number and back
 * would write a different line than the operator typed.
 *
 * The bounds, the choices and the keyframe rule are deliberately not here.
 * `engineSettingsProblem` owns them, the drawer and the deploy both call it,
 * and a yup copy would be a third rule to keep in step.
 */
const settingValueFields = Object.fromEntries(
  [...engineSettingsFields(SRS_SERVICE), ...engineSettingsFields(OME_SERVICE)]
    .map((field) => field.key)
    .map((key) => [key, string().notRequired()]),
);

// noUnknown strips a key neither engine reads, so a stale drawer cannot store
// one. Anything it lets through is checked again by engineSettingsProblem,
// which names the engine that does not read it.
export const engineSettingsSchema = object(settingValueFields).noUnknown(true);

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
