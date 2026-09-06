import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with Node's built-in scrypt.
 *
 * The stored string is `scrypt$N$r$p$<salt base64>$<key base64>`. The cost
 * parameters travel with every hash, so they can be raised here without
 * invalidating the passwords already stored: verification always uses the
 * parameters the hash was written with.
 */
export interface ScryptParams {
  /** CPU and memory cost, a power of two. */
  N: number;
  /** Block size. */
  r: number;
  /** Parallelisation. */
  p: number;
}

export const CURRENT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 3 };

const SALT_BYTES = 32;
const KEY_BYTES = 64;

// Node's default cap is 32 MiB, and N=2^15 with r=8 needs exactly that for the
// mixing buffer alone, so scrypt would refuse to run without a raised ceiling.
const MAX_MEM_BYTES = 64 * 1024 * 1024;

const ALGORITHM = 'scrypt';
const FIELD_SEPARATOR = '$';
const FIELD_COUNT = 6;

interface StoredHash {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}

function deriveKey(
  password: string,
  salt: Buffer,
  keyBytes: number,
  params: ScryptParams,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keyBytes,
      { ...params, maxmem: MAX_MEM_BYTES },
      (err, key) => {
        if (err) reject(err);
        else resolve(key);
      },
    );
  });
}

function encode(params: ScryptParams, salt: Buffer, key: Buffer): string {
  return [
    ALGORITHM,
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join(FIELD_SEPARATOR);
}

function decode(stored: string): StoredHash | null {
  const fields = stored.split(FIELD_SEPARATOR);
  if (fields.length !== FIELD_COUNT || fields[0] !== ALGORITHM) return null;

  const N = Number(fields[1]);
  const r = Number(fields[2]);
  const p = Number(fields[3]);
  const positiveIntegers = [N, r, p].every(
    (value) => Number.isInteger(value) && value >= 1,
  );
  if (!positiveIntegers || N < 2) return null;

  const salt = Buffer.from(fields[4]!, 'base64');
  const key = Buffer.from(fields[5]!, 'base64');
  if (salt.length === 0 || key.length === 0) return null;

  return { params: { N, r, p }, salt, key };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(password, salt, KEY_BYTES, CURRENT_PARAMS);
  return encode(CURRENT_PARAMS, salt, key);
}

/**
 * Whether `password` produced `stored`. False for a malformed stored value, so
 * an unreadable row refuses everyone rather than letting anyone in.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parsed = decode(stored);
  if (!parsed) return false;

  const candidate = await deriveKey(
    password,
    parsed.salt,
    parsed.key.length,
    parsed.params,
  );
  return timingSafeEqual(candidate, parsed.key);
}

/** The parameters a stored hash was written with, or null if it is unreadable. */
export function paramsOf(stored: string): ScryptParams | null {
  return decode(stored)?.params ?? null;
}
