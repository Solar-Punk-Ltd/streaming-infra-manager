import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;

/**
 * A fresh session token. This value goes into the cookie and nowhere else: the
 * database stores only `hashSessionToken` of it, so a dump of the sessions
 * table signs nobody in.
 */
export function createSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
