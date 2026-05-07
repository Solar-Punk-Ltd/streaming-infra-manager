import { object, string, InferType } from 'yup';

import { PROFILE_KINDS } from '../types.js';

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

export const profileNameSchema = object({
  name: string()
    .required()
    .matches(PROFILE_NAME_RE, 'name must match /^[a-z0-9][a-z0-9-]{0,30}$/'),
}).strict();

export const createProfileSchema = object({
  name: string()
    .required()
    .matches(PROFILE_NAME_RE, 'name must match /^[a-z0-9][a-z0-9-]{0,30}$/'),
  kind: string()
    .oneOf([...PROFILE_KINDS])
    .default('custom'),
  notes: string().nullable().notRequired().max(500),
}).noUnknown(true);

export type CreateProfileInput = InferType<typeof createProfileSchema>;
