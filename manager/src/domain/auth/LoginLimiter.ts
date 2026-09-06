import {
  LOGIN_MAX_LOCKOUT_MS,
  lockoutMsFor,
} from '@streaming-infra-manager/common';

/**
 * A key with no failures for this long starts again from zero. Twice the
 * longest lockout, so sitting one out does not by itself wipe the count.
 */
const FORGET_MS = 2 * LOGIN_MAX_LOCKOUT_MS;

/**
 * Ceiling on tracked keys. Every failed attempt makes an entry under whatever
 * username was sent, and nothing may be forgotten for two hours, so without a
 * cap the map grows with what an attacker chooses to type.
 */
export const MAX_TRACKED_KEYS = 10_000;

/**
 * How many of the oldest keys go when the cap is reached. A batch, so choosing
 * them costs one pass per thousand new keys instead of one per failure.
 */
const EVICTION_BATCH = 1_000;

interface Attempts {
  /** Failures that are over and counted. */
  failures: number;
  /** Attempts reserved by `begin` whose password is still being checked. */
  pending: number;
  lastFailureAt: number;
  lockedUntil: number;
}

export function usernameKey(username: string): string {
  return `username:${username.toLowerCase()}`;
}

export function clientIpKey(ip: string): string {
  return `ip:${ip}`;
}

/**
 * Changing a password checks the current one, which is a password check like
 * any other. Its own key, so guessing it neither locks the account out of
 * signing in nor borrows the sign-in count.
 */
export function passwordChangeKey(userId: number): string {
  return `password-change:${userId}`;
}

/** The keys one attempt is counted against. */
export interface AttemptKeys {
  /** The account being tried. A right password wipes this key clean. */
  account: string;
  /**
   * Keys many accounts share, such as the client address. A right password
   * takes only its own attempt back out of these, never anyone else's.
   */
  shared?: readonly string[];
}

/**
 * An attempt that has been counted before it was made. Settle it with exactly
 * one of `fail` and `succeed` once the password has been checked.
 */
export interface LoginAttempt {
  /** How long the caller must wait, or 0 when the attempt may go ahead. */
  readonly lockedForSeconds: number;
  /** The password was wrong. The attempt stays counted. */
  fail(): void;
  /** The password was right. The attempt is taken back off the keys. */
  succeed(): void;
}

/** A refused attempt reserved nothing, so it has nothing to settle. */
const NOTHING_TO_SETTLE = {
  fail: () => undefined,
  succeed: () => undefined,
};

/**
 * Brute-force throttling for sign-in, held in memory in the single API process.
 *
 * Five failures on a key lock it for a minute, and every failure after that
 * doubles the wait up to an hour. Keys are the username and the client IP, so
 * neither guessing one password from many places nor many passwords from one
 * place gets more than five free tries.
 *
 * In memory rather than in Postgres on purpose: the manager runs as one
 * process, and a limiter that has to survive a restart would be a write per
 * failed guess, which is the thing an attacker controls.
 */
export class LoginLimiter {
  private readonly attempts = new Map<string, Attempts>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Reserves one attempt on every key, before the password is checked.
   *
   * Reading the lockout and recording the failure used to sit either side of an
   * awaited scrypt, so twenty sign-ins sent together all read zero failures and
   * all got their guess. Here the count moves in the same synchronous call that
   * reads it, and only the free attempts get through.
   */
  begin(keys: AttemptKeys): LoginAttempt {
    const all = [keys.account, ...(keys.shared ?? [])];
    const now = this.now();

    const lockedForSeconds = Math.max(
      ...all.map((key) => this.waitSeconds(key, now)),
    );
    if (lockedForSeconds > 0) return { lockedForSeconds, ...NOTHING_TO_SETTLE };

    if (this.attempts.size >= MAX_TRACKED_KEYS) this.makeRoom(now);
    for (const key of all) this.reserve(key, now);

    return {
      lockedForSeconds: 0,
      fail: () => {
        for (const key of all) this.countFailure(key);
      },
      succeed: () => {
        for (const key of all) this.giveTheAttemptBack(key);
        this.attempts.delete(keys.account);
      },
    };
  }

  /** Seconds this key must wait, or 0 when it may try now. */
  retryAfterSeconds(key: string): number {
    return this.waitSeconds(key, this.now());
  }

  /** How many keys are held, which is what MAX_TRACKED_KEYS bounds. */
  trackedKeys(): number {
    return this.attempts.size;
  }

  private waitSeconds(key: string, now: number): number {
    const entry = this.live(key, now);
    if (!entry) return 0;

    // Reserved attempts count towards the lockout even though none of them has
    // come back yet. Without that, twenty guesses sent at once would all pass
    // this check before the first of them had failed.
    const withPending =
      entry.pending > 0 ? now + lockoutMsFor(entry.failures + entry.pending) : 0;
    const until = Math.max(entry.lockedUntil, withPending);
    return until <= now ? 0 : Math.ceil((until - now) / 1000);
  }

  private reserve(key: string, now: number): void {
    const entry = this.live(key, now);
    this.attempts.set(key, {
      failures: entry?.failures ?? 0,
      pending: (entry?.pending ?? 0) + 1,
      lastFailureAt: entry?.lastFailureAt ?? now,
      lockedUntil: entry?.lockedUntil ?? 0,
    });
  }

  private countFailure(key: string): void {
    const entry = this.attempts.get(key);
    if (!entry) return;

    const now = this.now();
    const failures = entry.failures + 1;
    this.attempts.set(key, {
      failures,
      pending: Math.max(0, entry.pending - 1),
      lastFailureAt: now,
      lockedUntil: now + lockoutMsFor(failures),
    });
  }

  private giveTheAttemptBack(key: string): void {
    const entry = this.attempts.get(key);
    if (!entry) return;

    const pending = Math.max(0, entry.pending - 1);
    if (entry.failures === 0 && pending === 0) {
      this.attempts.delete(key);
      return;
    }
    this.attempts.set(key, { ...entry, pending });
  }

  /** The entry for `key`, dropping it first if it has been quiet long enough. */
  private live(key: string, now: number): Attempts | undefined {
    const entry = this.attempts.get(key);
    if (!entry) return undefined;
    if (isForgettable(entry, now)) {
      this.attempts.delete(key);
      return undefined;
    }
    return entry;
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.attempts) {
      if (isForgettable(entry, now)) this.attempts.delete(key);
    }
  }

  /**
   * Drops the keys that failed longest ago, locked or not. A lockout thrown
   * away early is the price of the cap, and the keys chosen are the ones whose
   * attacker has moved on. Attempts still in flight are left alone: their
   * handle has to find them again to settle.
   */
  private makeRoom(now: number): void {
    this.sweep(now);
    if (this.attempts.size < MAX_TRACKED_KEYS) return;

    const oldestFirst = [...this.attempts]
      .filter(([, entry]) => entry.pending === 0)
      .sort(([, a], [, b]) => a.lastFailureAt - b.lastFailureAt);

    for (const [key] of oldestFirst.slice(0, EVICTION_BATCH)) {
      this.attempts.delete(key);
    }
  }
}

function isForgettable(entry: Attempts, now: number): boolean {
  return (
    entry.pending === 0 &&
    entry.lockedUntil <= now &&
    now - entry.lastFailureAt >= FORGET_MS
  );
}
