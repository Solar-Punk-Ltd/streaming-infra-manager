import {
  SRT_PASSPHRASE_MESSAGE,
  SRT_PASSPHRASE_RE,
} from '@streaming-infra-manager/common';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * The field rules the wizard and the drawers check before anything is sent.
 *
 * Every regex here is the manager's own, copied from
 * `manager/src/schemas/profile.ts`. They are duplicated rather than imported
 * because the schemas live behind yup in the API package, and a form that
 * guesses at the rules refuses values the server accepts, or worse accepts
 * values it refuses and turns a typo into a failed request.
 */
// Exported so anything that has to agree with these rules can test against the
// same expressions rather than writing its own.
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
export const HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,127}$/;
export const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
export const STAMP_ID_RE = /^(0x)?[0-9a-fA-F]{64}$/;

export const NOTES_MAX = 500;

const NAME_RULE =
  'lowercase letters, digits and dashes, max 31 characters';
const HOST_RULE = 'an ssh alias or user@host, like deploy@10.0.0.7';
const ADDRESS_RULE = '0x plus 40 hex characters';
const PRIVATE_KEY_RULE = '0x plus 64 hex characters';
const STAMP_ID_RULE = '64 hex characters, with or without 0x in front';

/** Every problem reader here answers the same way: a sentence, or nothing. */
export type Problem = string | null;

export function nameProblem(value: string): Problem {
  if (!value.trim()) return 'Enter a name';
  return NAME_RE.test(value) ? null : `Name: ${NAME_RULE}`;
}

export function hostProblem(value: string): Problem {
  if (!value.trim()) return 'Enter the host';
  return HOST_RE.test(value) ? null : `Host: ${HOST_RULE}`;
}

export function addressProblem(value: string): Problem {
  if (!value.trim()) return 'Enter the streamer address';
  return ETH_ADDRESS_RE.test(value) ? null : `Streamer address: ${ADDRESS_RULE}`;
}

export function privateKeyProblem(value: string): Problem {
  if (!value.trim()) return 'Enter the stream key';
  if (!PRIVATE_KEY_RE.test(value)) return `Stream key: ${PRIVATE_KEY_RULE}`;
  // The right shape is not enough: all zeros, or a value past the curve order,
  // derives no address, and saving it would wipe the stream's public key.
  return addressForKey(value) === null
    ? 'Stream key: not a usable key, no address can be derived from it'
    : null;
}

export function stampIdProblem(value: string): Problem {
  if (!value.trim()) return 'Enter the stamp ID';
  return STAMP_ID_RE.test(value) ? null : `Stamp ID: ${STAMP_ID_RULE}`;
}

export function passphraseProblem(value: string): Problem {
  if (!value.trim()) return 'Enter a passphrase';
  return SRT_PASSPHRASE_RE.test(value)
    ? null
    : `Passphrase ${SRT_PASSPHRASE_MESSAGE}`;
}

export function notesProblem(value: string): Problem {
  return value.length > NOTES_MAX
    ? `Notes: shorten to ${NOTES_MAX} characters, this is ${value.length}`
    : null;
}

export function groupSizeProblem(value: string): Problem {
  const count = Number(value);
  return Number.isInteger(count) && count >= 1
    ? null
    : 'How many: a whole number, 1 or more';
}

/** The public address a stream key signs with, or null when it is not a key. */
export function addressForKey(privateKey: string): string | null {
  if (!PRIVATE_KEY_RE.test(privateKey.trim())) return null;
  try {
    return privateKeyToAccount(privateKey.trim() as `0x${string}`).address;
  } catch {
    return null;
  }
}
