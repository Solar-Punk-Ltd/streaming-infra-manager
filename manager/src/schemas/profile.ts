import { array, object, string, InferType } from 'yup';

import { ALL_SERVICES, PROFILE_KINDS } from '../types/index.js';

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

const HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,127}$/; // like localhost or "user@host"
const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const STAMP_ID_RE = /^(0x)?[0-9a-fA-F]{64}$/;
const FEED_TOPIC_RE = /^[\x20-\x7E]{1,128}$/;

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
  host: string()
    .notRequired()
    .matches(HOST_RE, 'host must be "localhost", an ssh alias, or user@host'),
  components: array()
    .of(
      string()
        .required()
        .oneOf([...ALL_SERVICES]),
    )
    .notRequired(),
  feed_owner: string()
    .notRequired()
    .matches(
      ETH_ADDRESS_RE,
      'feed_owner must be a 0x-prefixed Ethereum address',
    ),
  feed_topic: string()
    .notRequired()
    .matches(
      FEED_TOPIC_RE,
      'feed_topic must be printable ASCII, max 128 chars',
    ),
  private_key: string()
    .notRequired()
    .matches(PRIVATE_KEY_RE, 'private_key must be 0x + 64 hex chars'),
  public_key: string()
    .notRequired()
    .matches(
      ETH_ADDRESS_RE,
      'public_key must be a 0x-prefixed Ethereum address',
    ),
  stamp_id: string()
    .notRequired()
    .matches(
      STAMP_ID_RE,
      'stamp_id must be 32-byte hex (optionally 0x-prefixed)',
    ),
}).noUnknown(true);

export type CreateProfileInput = InferType<typeof createProfileSchema>;

export const updateProfileSchema = object({
  kind: string()
    .oneOf([...PROFILE_KINDS])
    .default('custom'),
  notes: string().nullable().notRequired().max(500),
  components: array()
    .of(
      string()
        .required()
        .oneOf([...ALL_SERVICES]),
    )
    .notRequired(),
  feed_owner: string()
    .notRequired()
    .matches(
      ETH_ADDRESS_RE,
      'feed_owner must be a 0x-prefixed Ethereum address',
    ),
  feed_topic: string()
    .notRequired()
    .matches(
      FEED_TOPIC_RE,
      'feed_topic must be printable ASCII, max 128 chars',
    ),
  private_key: string()
    .notRequired()
    .matches(PRIVATE_KEY_RE, 'private_key must be 0x + 64 hex chars'),
  public_key: string()
    .notRequired()
    .matches(
      ETH_ADDRESS_RE,
      'public_key must be a 0x-prefixed Ethereum address',
    ),
  stamp_id: string()
    .notRequired()
    .matches(
      STAMP_ID_RE,
      'stamp_id must be 32-byte hex (optionally 0x-prefixed)',
    ),
}).noUnknown(true);

export type UpdateProfileInput = InferType<typeof updateProfileSchema>;
