import type { AdminLinkTokenChoice } from '@streaming-infra-manager/common';
import { InferType, mixed, number, object, string } from 'yup';

/** Far past any real address or token, while keeping a save a small request. */
const MAX_TEXT_LENGTH = 8192;

/**
 * yup's own message for a value of the wrong type repeats the value, and the
 * token is a secret, so every rule here words its own message and names no
 * value.
 */
const URL_MESSAGE = 'url is text, the admin address, or empty for no default';
const TOKEN_MESSAGE = 'token is text to replace the stored one, or null to clear it';
const LENGTH_MESSAGE = `url and token hold at most ${MAX_TEXT_LENGTH} characters each`;

const withinLength = (value: unknown): boolean => typeof value !== 'string' || value.length <= MAX_TEXT_LENGTH;

/**
 * What `PUT /manager-settings/admin-link` takes. Only the shape: whether the
 * stack takes the address and the token is the service's to answer. Unknown
 * keys are refused rather than dropped, because a misspelt token key dropped
 * would read as a request to keep the stored token.
 */
export const saveManagerAdminLinkSchema = object({
  expectedRevision: number()
    .typeError('expectedRevision is the revision the page read, a whole number')
    .required('expectedRevision is the revision the page read, a whole number')
    .integer('expectedRevision is the revision the page read, a whole number')
    .min(0, 'expectedRevision is the revision the page read, a whole number'),
  url: mixed<string>()
    .defined(URL_MESSAGE)
    .test('text', URL_MESSAGE, (value) => typeof value === 'string')
    .test('length', LENGTH_MESSAGE, withinLength),
  token: mixed<string>()
    .nullable()
    .test('text-or-null', TOKEN_MESSAGE, (value) => value === undefined || value === null || typeof value === 'string')
    .test('length', LENGTH_MESSAGE, withinLength),
}).noUnknown(true);

export type SaveManagerAdminLinkBody = InferType<typeof saveManagerAdminLinkSchema>;

const TEST_URL_MESSAGE = 'url is text, the admin address to test';
const TOKEN_CHOICE_MESSAGE = 'token is either the stored one, { "source": "stored" }, or one typed, { "source": "typed", "value": "..." }';
const FEED_OWNER_MESSAGE = 'feedOwner is a stream address, 40 hex characters with or without 0x';
const FEED_OWNER_RE = /^(0x)?[0-9a-fA-F]{40}$/;

/** Exactly one of the two token choices, with no other key, whose typed value is text. */
function isTokenChoice(value: unknown): value is AdminLinkTokenChoice {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const choice = value as Record<string, unknown>;
  const keys = Object.keys(choice).sort().join(',');
  if (choice.source === 'stored') return keys === 'source';
  return choice.source === 'typed' && keys === 'source,value' && typeof choice.value === 'string';
}

/**
 * What `POST /manager-settings/admin-link/test` takes: an address typed on a
 * page, the token to present, and the stream address to compare the admin's
 * owner with, where the page has one. Only the shape here, with messages that
 * name no value.
 */
export const testAdminLinkSchema = object({
  url: mixed<string>()
    .defined(TEST_URL_MESSAGE)
    .test('text', TEST_URL_MESSAGE, (value) => typeof value === 'string')
    .test('length', LENGTH_MESSAGE, withinLength),
  token: mixed<AdminLinkTokenChoice>()
    .defined(TOKEN_CHOICE_MESSAGE)
    .test('choice', TOKEN_CHOICE_MESSAGE, isTokenChoice)
    .test('length', LENGTH_MESSAGE, (value) => !isTokenChoice(value) || value.source === 'stored' || withinLength(value.value)),
  feedOwner: string().typeError(FEED_OWNER_MESSAGE).nullable().notRequired().matches(FEED_OWNER_RE, FEED_OWNER_MESSAGE),
}).noUnknown(true);

export type TestAdminLinkBody = InferType<typeof testAdminLinkSchema>;
