import { createHash, randomBytes } from 'node:crypto';

import { isSecretSettingKey } from '@streaming-infra-manager/common';

import type { ContainerRow } from '../ContainerRepository.js';

/**
 * The keys that hold a chain endpoint, which can carry a provider's key in its
 * path or its user info. The manager shows a deployment's own endpoint by its
 * host alone, and a record keeps no copy of it in clear either.
 */
const CHAIN_ENDPOINT_KEYS: readonly string[] = ['RPC_ENDPOINT', 'BEE_GATEWAY_RPC_ENDPOINT'];

const SALT_BYTES = 16;

/** The byte after the key in a value's digest. A value's own bytes follow it. */
const VALUE_MARK = '\0';
/** The byte after the key in an unset key's digest, which no value's digest has in that place. */
const UNSET_MARK = '\x01';

/** Whether a key holds a chain endpoint, which the page shows by its host alone. */
export function isChainEndpointKey(key: string): boolean {
  return CHAIN_ENDPOINT_KEYS.includes(key);
}

/** Whether a container record may keep this key's value in clear, rather than as a digest alone. */
export function isRecordedInClear(key: string): boolean {
  return !isSecretSettingKey(key) && !isChainEndpointKey(key);
}

/** A fresh salt for one container record, so no two records share a digest of the same value. */
export function newRecordSalt(): string {
  return randomBytes(SALT_BYTES).toString('hex');
}

/**
 * What a record keeps to tell whether a value is the one its container was
 * started with. The key is part of it, and the NUL between key and value is a
 * byte neither can hold, so the same text under two keys, or split between key
 * and value two ways, gives two digests.
 */
export function settingDigest(salt: string, key: string, value: string): string {
  return createHash('sha256').update(salt).update(key).update(VALUE_MARK).update(value).digest('hex');
}

/** What a record keeps for a key the environment left unset, which no value's digest equals. */
export function unsetDigest(salt: string, key: string): string {
  return createHash('sha256').update(salt).update(key).update(UNSET_MARK).digest('hex');
}

/** The digest a record keeps for a key, set to `value` or unset when it is undefined. */
export function digestOf(salt: string, key: string, value: string | undefined): string {
  return value === undefined ? unsetDigest(salt, key) : settingDigest(salt, key, value);
}

/**
 * Whether this container was started with `value` for the key, undefined
 * meaning unset. A record written before digests were kept, and a key the
 * record does not cover, say nothing either way.
 */
export function recordedStateOf(
  record: Pick<ContainerRow, 'env_salt' | 'env_digests'>,
  key: string,
  value: string | undefined,
): 'same' | 'differs' | 'unknown' {
  const recorded = record.env_digests[key];
  if (record.env_salt === null || recorded === undefined) return 'unknown';
  return recorded === digestOf(record.env_salt, key, value) ? 'same' : 'differs';
}
