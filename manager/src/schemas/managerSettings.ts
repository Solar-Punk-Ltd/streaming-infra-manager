import { InferType, mixed, number, object } from 'yup';

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
