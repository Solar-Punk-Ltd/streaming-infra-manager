import { createHash, randomBytes } from 'node:crypto';

import { isSecretSettingKey } from '@streaming-infra-manager/common';

/**
 * The keys that hold a chain endpoint, which can carry a provider's key in its
 * path or its user info. The manager shows a deployment's own endpoint by its
 * host alone, and a record keeps no copy of it in clear either.
 */
const CHAIN_ENDPOINT_KEYS: readonly string[] = ['RPC_ENDPOINT', 'BEE_GATEWAY_RPC_ENDPOINT'];

const SALT_BYTES = 16;

/** Whether a container record may keep this key's value in clear, rather than as a digest alone. */
export function isRecordedInClear(key: string): boolean {
  return !isSecretSettingKey(key) && !CHAIN_ENDPOINT_KEYS.includes(key);
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
  return createHash('sha256').update(salt).update(key).update('\0').update(value).digest('hex');
}
