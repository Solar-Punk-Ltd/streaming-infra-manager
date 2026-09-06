/**
 * The rules the manager, the frontend and the mock all read from here.
 *
 * The password rule is deliberately short: length, and not containing the
 * username. This pins the boundaries, because an off-by-one on the minimum is
 * the kind of thing nobody notices in review. The username rule is a copy of a
 * CHECK constraint in 008_auth.sql, so it is pinned against the same strings
 * the database would refuse. The lockout schedule is the whole brute-force
 * defence and every number in it is a decision someone could quietly change.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LOGIN_FREE_ATTEMPTS,
  LOGIN_MAX_LOCKOUT_MS,
  lockoutMsFor,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordProblem,
  USERNAME_MAX_LENGTH,
  usernameProblem,
} from './auth.js';

const USERNAME = 'levi';

describe('password policy', () => {
  it('accepts anything printable of the right length', () => {
    const fine = [
      'a'.repeat(PASSWORD_MIN_LENGTH),
      'a'.repeat(PASSWORD_MAX_LENGTH),
      'correct horse battery staple',
      '!"#$%&/()=?*<>|;:_-.,',
      'kávé és tejszínhab kérem',
    ];

    for (const password of fine) {
      assert.equal(
        passwordProblem(password, USERNAME),
        null,
        `should accept ${JSON.stringify(password)}`,
      );
    }
  });

  it('refuses one character short of the minimum', () => {
    assert.match(
      passwordProblem('a'.repeat(PASSWORD_MIN_LENGTH - 1), USERNAME) ?? '',
      /at least 12 characters/,
    );
  });

  it('refuses one character past the maximum', () => {
    assert.match(
      passwordProblem('a'.repeat(PASSWORD_MAX_LENGTH + 1), USERNAME) ?? '',
      /at most 128 characters/,
    );
  });

  it('refuses a password carrying the username, in any case', () => {
    for (const password of [
      'levi-is-my-name',
      'my-name-is-LEVI-ok',
      'xxxxLevixxxxx',
    ]) {
      assert.equal(
        passwordProblem(password, USERNAME),
        'password must not contain the username',
        `should refuse ${password}`,
      );
    }
  });

  it('reports length before it reports the username', () => {
    // A short password that also carries the username should say what the
    // operator will hit first, not the more surprising rule.
    assert.match(passwordProblem('levi', USERNAME) ?? '', /at least/);
  });
});

describe('username rules', () => {
  it('accepts what the database CHECK accepts', () => {
    for (const username of [
      'ab',
      'levi',
      'a.b_c-d',
      '0start',
      'x'.repeat(USERNAME_MAX_LENGTH),
    ]) {
      assert.equal(usernameProblem(username), null, `should accept ${username}`);
    }
  });

  it('refuses what the database CHECK refuses', () => {
    for (const username of [
      'a',
      'A',
      'Upper',
      'has space',
      '-lead',
      '.lead',
      'x'.repeat(USERNAME_MAX_LENGTH + 1),
      '',
    ]) {
      assert.ok(usernameProblem(username), `should refuse ${username}`);
    }
  });
});

describe('the lockout schedule', () => {
  it('is free up to the fourth failure', () => {
    for (let failures = 0; failures <= LOGIN_FREE_ATTEMPTS; failures += 1) {
      assert.equal(lockoutMsFor(failures), 0, `${failures} failures`);
    }
  });

  it('starts at a minute on the fifth and doubles, capped at an hour', () => {
    const minutes = [1, 2, 4, 8, 16, 32, 60, 60];

    minutes.forEach((expected, index) => {
      assert.equal(
        lockoutMsFor(LOGIN_FREE_ATTEMPTS + 1 + index),
        expected * 60 * 1000,
        `failure ${LOGIN_FREE_ATTEMPTS + 1 + index}`,
      );
    });
    assert.equal(lockoutMsFor(100), LOGIN_MAX_LOCKOUT_MS);
  });
});
