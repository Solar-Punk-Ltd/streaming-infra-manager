/**
 * The session token, and what the database is allowed to hold of it.
 *
 * Unit test, no database. The one property this file exists for is that the
 * stored value is never the value in the cookie: if those two are ever the same
 * string, a copy of the sessions table is a set of working session cookies.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createSessionToken,
  hashSessionToken,
} from '../../src/domain/auth/sessionToken.js';

describe('session token', () => {
  it('is 32 random bytes in base64url', () => {
    const token = createSessionToken();

    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
  });

  it('is different every time', () => {
    const tokens = new Set(
      Array.from({ length: 100 }, () => createSessionToken()),
    );
    assert.equal(tokens.size, 100);
  });

  it('never stores the token itself', () => {
    for (let i = 0; i < 50; i += 1) {
      const token = createSessionToken();
      const stored = hashSessionToken(token);

      assert.notEqual(stored, token);
      assert.equal(stored.includes(token), false);
      assert.match(stored, /^[0-9a-f]{64}$/);
    }
  });

  it('hashes the same token to the same value, so a lookup can find it', () => {
    const token = createSessionToken();
    assert.equal(hashSessionToken(token), hashSessionToken(token));
    assert.notEqual(hashSessionToken(token), hashSessionToken(`${token}x`));
  });
});
