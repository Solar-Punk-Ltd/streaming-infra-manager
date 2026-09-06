/**
 * The brute-force schedule.
 *
 * Unit test, no clock of its own: the limiter takes its `now`, so a test can
 * walk an hour forward without waiting. The numbers pinned here are the whole
 * defence, and each of them is a decision someone could quietly change: five
 * free attempts, one minute for the fifth, doubling after that, an hour's cap,
 * and a right password wiping the count. The last case is the one that is not
 * about the schedule at all: attempts still waiting on scrypt have to count,
 * or a burst sent together gets one free guess each.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clientIpKey,
  LoginLimiter,
  MAX_TRACKED_KEYS,
  usernameKey,
  type AttemptKeys,
} from '../../src/domain/auth/LoginLimiter.js';

const MINUTE = 60 * 1000;
const KEY = usernameKey('levi');

/** A limiter whose clock the test moves by hand. */
function limiterAt(start = 1_700_000_000_000) {
  const clock = { now: start };
  return {
    clock,
    limiter: new LoginLimiter(() => clock.now),
    advance(ms: number) {
      clock.now += ms;
    },
  };
}

/** One wrong password, start to finish. Returns the wait it was refused with. */
function wrongPassword(
  limiter: LoginLimiter,
  keys: AttemptKeys = { account: KEY },
): number {
  const attempt = limiter.begin(keys);
  attempt.fail();
  return attempt.lockedForSeconds;
}

describe('LoginLimiter', () => {
  it('allows four failures without locking', () => {
    const { limiter } = limiterAt();

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      assert.equal(
        wrongPassword(limiter),
        0,
        `failure ${attempt} must not lock`,
      );
    }
    assert.equal(limiter.retryAfterSeconds(KEY), 0);
  });

  it('locks for a minute on the fifth failure', () => {
    const { limiter } = limiterAt();

    for (let attempt = 1; attempt <= 5; attempt += 1) wrongPassword(limiter);

    assert.equal(limiter.retryAfterSeconds(KEY), 60);
  });

  it('doubles the wait on every further failure, up to an hour', () => {
    const { limiter, advance } = limiterAt();
    const expectedMinutes = [1, 2, 4, 8, 16, 32, 60, 60, 60];

    for (let attempt = 1; attempt <= 4; attempt += 1) wrongPassword(limiter);

    for (const minutes of expectedMinutes) {
      wrongPassword(limiter);
      assert.equal(
        limiter.retryAfterSeconds(KEY),
        minutes * 60,
        `expected a ${minutes} minute lockout`,
      );
      // Wait it out, then fail again: the count keeps climbing.
      advance(minutes * MINUTE);
      assert.equal(limiter.retryAfterSeconds(KEY), 0);
    }
  });

  it('counts down while it is locked', () => {
    const { limiter, advance } = limiterAt();

    for (let attempt = 1; attempt <= 5; attempt += 1) wrongPassword(limiter);
    advance(20_000);
    assert.equal(limiter.retryAfterSeconds(KEY), 40);

    advance(39_999);
    assert.equal(limiter.retryAfterSeconds(KEY), 1);

    advance(1);
    assert.equal(limiter.retryAfterSeconds(KEY), 0);
  });

  it('forgets a key after two quiet hours', () => {
    const { limiter, advance } = limiterAt();

    for (let attempt = 1; attempt <= 5; attempt += 1) wrongPassword(limiter);
    advance(120 * MINUTE);

    // Back to a clean slate: four more failures must not lock again.
    for (let attempt = 1; attempt <= 4; attempt += 1) wrongPassword(limiter);
    assert.equal(limiter.retryAfterSeconds(KEY), 0);
  });

  it('wipes the account key when the password is finally right', () => {
    const { limiter } = limiterAt();
    for (let attempt = 1; attempt <= 4; attempt += 1) wrongPassword(limiter);

    limiter.begin({ account: KEY }).succeed();

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      assert.equal(
        wrongPassword(limiter),
        0,
        `failure ${attempt} after the reset`,
      );
    }
  });

  it('takes a successful attempt back off the shared key', () => {
    const { limiter } = limiterAt();
    const address = clientIpKey('10.0.0.1');
    const keys = { account: KEY, shared: [address] };

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      wrongPassword(limiter, keys);
    }
    limiter.begin(keys).succeed();

    // The account starts from zero again, and the address is left holding the
    // four failures it earned rather than five: the attempt that worked was
    // never one of them, and a reservation left behind would have locked it.
    assert.equal(limiter.retryAfterSeconds(KEY), 0);
    assert.equal(limiter.retryAfterSeconds(address), 0);

    wrongPassword(limiter, { account: usernameKey('mate'), shared: [address] });
    assert.equal(limiter.retryAfterSeconds(address), 60);
  });

  it('counts the attempts that have not come back yet', () => {
    const { limiter } = limiterAt();

    // Five sign-ins waiting on scrypt and not one of them settled. This is the
    // shape of a burst sent all at once, and it used to see zero failures.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      assert.equal(
        limiter.begin({ account: KEY }).lockedForSeconds,
        0,
        `attempt ${attempt} should have been reserved`,
      );
    }

    assert.equal(limiter.begin({ account: KEY }).lockedForSeconds, 60);
    assert.equal(limiter.retryAfterSeconds(KEY), 60);
  });

  it('stops growing at the cap, and keeps the newest key', () => {
    const { limiter, advance } = limiterAt();
    const newest = usernameKey('arrived-last');

    // Usernames are whatever the caller sent, so this is a cheap thing for an
    // attacker to do and none of it may be forgotten for two hours.
    for (let n = 0; n < MAX_TRACKED_KEYS; n += 1) {
      wrongPassword(limiter, { account: usernameKey(`guess-${n}`) });
      advance(1);
    }
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      wrongPassword(limiter, { account: newest });
    }

    assert.ok(
      limiter.trackedKeys() <= MAX_TRACKED_KEYS,
      `${limiter.trackedKeys()} keys held, the cap is ${MAX_TRACKED_KEYS}`,
    );
    assert.equal(
      limiter.retryAfterSeconds(newest),
      60,
      'the oldest keys go first, so the newest lockout survives',
    );
  });

  it('keeps every key on its own count', () => {
    const { limiter } = limiterAt();
    const other = usernameKey('someone-else');
    const ip = clientIpKey('10.0.0.1');

    for (let attempt = 1; attempt <= 5; attempt += 1) wrongPassword(limiter);

    assert.equal(limiter.retryAfterSeconds(KEY), 60);
    assert.equal(limiter.retryAfterSeconds(other), 0);
    assert.equal(limiter.retryAfterSeconds(ip), 0);
  });

  it('reads a username the same however it was capitalised', () => {
    assert.equal(usernameKey('Levi'), usernameKey('levi'));
    assert.notEqual(usernameKey('levi'), clientIpKey('levi'));
  });
});
