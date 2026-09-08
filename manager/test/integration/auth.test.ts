/**
 * The way in: the session cookie and the write header, and what the manager
 * answers to a request without them.
 *
 * Requires the running stack and a user to sign in as, see README.md. Nothing
 * here creates a deployment: the one write it sends is refused before the
 * body is read, and the body would not pass validation anyway.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { requestWith, requireStack, signIn, signOut } from './helpers.js';

before(requireStack);

describe('signed in the way the browser is', () => {
  it('reads with the session cookie', async () => {
    const { status } = await requestWith('GET', '/profiles');

    assert.equal(status, 200);
  });

  it('is refused a read without the cookie', async () => {
    const { status, body } = await requestWith('GET', '/profiles', undefined, {
      cookie: null,
    });

    assert.equal(status, 401);
    assert.deepEqual(body, { error: 'not_signed_in' });
  });

  it('is refused a write without the request header, before the body is read', async () => {
    // The body is not JSON on purpose: read first, it would be answered with
    // 400 for the body rather than 403 for the missing header.
    const { status, body } = await requestWith('POST', '/profiles', undefined, {
      requestedWith: false,
      rawBody: '{ not json',
    });

    assert.equal(status, 403);
    assert.equal((body as { error?: string }).error, 'cross_site_request');
  });

  it('is refused with the cookie of a session that was signed out', async () => {
    const ended = await signOut();
    assert.ok(ended, 'there was a session to sign out of');
    try {
      const { status } = await requestWith('GET', '/profiles', undefined, {
        cookie: ended,
      });

      assert.equal(status, 401);
    } finally {
      await signIn();
    }
  });
});
