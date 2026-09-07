import { randomBytes } from 'node:crypto';

import {
  passwordProblem,
  usernameProblem,
  type UserSummary,
} from '@streaming-infra-manager/common';

import {
  CannotRemoveUserError,
  InvalidCredentialsError,
  InvalidUsernameError,
  LockedOutError,
  NoUsersError,
  UserExistsError,
  UserNotFoundError,
  WeakPasswordError,
} from '../errors/index.js';
import { Logger } from '../Logger.js';

import type { CredentialRepository } from './CredentialRepository.js';
import {
  clientIpKey,
  LoginLimiter,
  passwordChangeKey,
  usernameKey,
} from './LoginLimiter.js';
import type { OpenStreams } from './OpenStreams.js';
import { hashPassword, verifyPassword } from './passwordHash.js';
import type { SessionRepository } from './SessionRepository.js';
import {
  absoluteExpiryFrom,
  endsAt,
  hasExpired,
  idleSince,
  needsTouch,
} from './sessionLifetime.js';
import { createSessionToken, hashSessionToken } from './sessionToken.js';
import type { UserRepository } from './UserRepository.js';

const logger = Logger.getInstance();

export interface SignedInUser {
  id: number;
  username: string;
  /** May add and remove users and sign anyone out. */
  isAdmin: boolean;
}

export interface SessionInfo {
  user: SignedInUser;
  tokenHash: string;
  /** When this session stops working if nothing else touches it. */
  expiresAt: Date;
}

export interface AddUserOptions {
  /** Let the new user add and remove users too. */
  admin?: boolean;
}

export interface SignInInput {
  username: string;
  password: string;
  ip: string;
  userAgent: string | null;
}

/**
 * Who may use the manager, and which sessions are open.
 *
 * Everything that decides whether a request gets in is here: the password
 * check, the lockout, the session's two clocks. The middleware and the routes
 * around it only translate between HTTP and these calls.
 *
 * Ending a session also ends the event streams it left open, which is the one
 * thing a request cannot do for itself: a stream outlives the request that
 * opened it.
 */
export class AuthService {
  /**
   * A throwaway hash to check an unknown username against, so a sign-in for a
   * name that does not exist costs the same time as one for a name that does.
   * Built in the background at startup, and an empty string if that fails,
   * which verifyPassword refuses like any other unreadable hash.
   */
  private readonly decoyHash: Promise<string>;

  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly credentials: CredentialRepository,
    private readonly openStreams: OpenStreams,
    private readonly limiter: LoginLimiter = new LoginLimiter(),
  ) {
    this.decoyHash = hashPassword(randomBytes(32).toString('base64')).catch(
      () => '',
    );
  }

  countUsers(): Promise<number> {
    return this.users.count();
  }

  async signIn(input: SignInInput): Promise<{ token: string }> {
    if ((await this.users.count()) === 0) throw new NoUsersError();

    // Reserved before the lookup and the hash, both of which are awaited: the
    // guesses that arrive together have to be counted before any of them is
    // checked, or they all pass a lockout that none of them has moved yet.
    const attempt = this.limiter.begin({
      account: usernameKey(input.username),
      shared: [clientIpKey(input.ip)],
    });
    if (attempt.lockedForSeconds > 0) {
      logger.warn(
        `[Auth] sign-in refused, locked out: username="${input.username}" ip=${input.ip} retryAfter=${attempt.lockedForSeconds}s`,
      );
      throw new LockedOutError(attempt.lockedForSeconds);
    }

    const user = await this.users.findByUsername(input.username);
    const matches = await verifyPassword(
      input.password,
      user ? user.password_hash : await this.decoyHash,
    );

    if (!user || !matches) {
      attempt.fail();
      logger.warn(
        `[Auth] failed sign-in: username="${input.username}" ip=${input.ip}`,
      );
      throw new InvalidCredentialsError();
    }

    attempt.succeed();

    const now = new Date();
    await this.sessions.deleteExpired(now, idleSince(now));

    const token = createSessionToken();
    await this.sessions.create({
      tokenHash: hashSessionToken(token),
      userId: user.id,
      expiresAt: absoluteExpiryFrom(now),
      ip: input.ip,
      userAgent: input.userAgent,
    });
    await this.users.markSignedIn(user.id, now);

    logger.info(`[Auth] ${user.username} signed in from ${input.ip}`);
    return { token };
  }

  async signOut(session: SessionInfo): Promise<void> {
    await this.sessions.deleteByTokenHash(session.tokenHash);
    this.openStreams.closeSession(session.tokenHash);
  }

  /** The session behind a cookie value, or null when it is unknown or over. */
  async sessionFor(token: string): Promise<SessionInfo | null> {
    const tokenHash = hashSessionToken(token);
    const session = await this.sessions.findByTokenHash(tokenHash);
    if (!session) return null;

    const now = new Date();
    if (hasExpired(session, now)) {
      await this.sessions.deleteByTokenHash(tokenHash);
      return null;
    }

    const touch = needsTouch(session, now);
    if (touch) await this.sessions.touch(tokenHash, now);

    return {
      user: {
        id: session.userId,
        username: session.username,
        isAdmin: session.isAdmin,
      },
      tokenHash,
      expiresAt: endsAt({
        ...session,
        lastSeenAt: touch ? now : session.lastSeenAt,
      }),
    };
  }

  async listUsers(): Promise<UserSummary[]> {
    const now = new Date();
    const [rows, sessionCounts] = await Promise.all([
      this.users.list(),
      this.sessions.countActiveByUser(now, idleSince(now)),
    ]);

    return rows.map((row) => ({
      id: row.id,
      username: row.username,
      isAdmin: row.is_admin,
      createdAt: row.created_at.toISOString(),
      lastLoginAt: row.last_login_at?.toISOString() ?? null,
      sessions: sessionCounts.get(row.id) ?? 0,
    }));
  }

  /**
   * The first user ever added can manage users whatever the caller asked,
   * because somebody has to be able to add the second.
   */
  async addUser(
    username: string,
    password: string,
    options: AddUserOptions = {},
  ): Promise<UserSummary> {
    const badName = usernameProblem(username);
    if (badName) throw new InvalidUsernameError(badName);

    const problem = passwordProblem(password, username);
    if (problem) throw new WeakPasswordError(problem);

    const isAdmin = options.admin === true || (await this.users.count()) === 0;
    const row = await this.users.insert(
      username,
      await hashPassword(password),
      isAdmin,
    );
    if (!row) throw new UserExistsError(username);

    logger.info(
      `[Auth] user added: ${username}${isAdmin ? ' (can manage users)' : ''}`,
    );
    return {
      id: row.id,
      username: row.username,
      isAdmin: row.is_admin,
      createdAt: row.created_at.toISOString(),
      lastLoginAt: null,
      sessions: 0,
    };
  }

  async removeUser(userId: number, actingUserId: number): Promise<void> {
    if (userId === actingUserId) {
      throw new CannotRemoveUserError(
        'You cannot remove your own account. Ask another user to remove it.',
      );
    }

    const outcome = await this.users.deleteUnlessLast(userId);
    if (outcome === 'missing') throw new UserNotFoundError(userId);
    if (outcome === 'last') {
      throw new CannotRemoveUserError(
        'This is the last user. Removing it would lock everyone out.',
      );
    }
    if (outcome === 'last_admin') {
      throw new CannotRemoveUserError(
        'This is the only user who can manage users. Removing it would leave nobody able to add or remove one.',
      );
    }
    this.openStreams.closeUser(userId);
    logger.info(`[Auth] user removed: id=${userId}`);
  }

  async revokeSessions(userId: number): Promise<void> {
    if (!(await this.users.findById(userId))) {
      throw new UserNotFoundError(userId);
    }
    await this.sessions.deleteForUser(userId);
    this.openStreams.closeUser(userId);
    logger.info(`[Auth] sessions revoked for user id=${userId}`);
  }

  /**
   * Change your own password. Every other session of yours is signed out, so a
   * password changed because it leaked also drops whoever had it.
   *
   * The current password is throttled like a sign-in: a stolen session would
   * otherwise be an unlimited guessing machine for the password behind it.
   */
  async changePassword(
    session: SessionInfo,
    current: string,
    next: string,
  ): Promise<void> {
    const attempt = this.limiter.begin({
      account: passwordChangeKey(session.user.id),
    });
    if (attempt.lockedForSeconds > 0) {
      logger.warn(
        `[Auth] password change refused, locked out: ${session.user.username} retryAfter=${attempt.lockedForSeconds}s`,
      );
      throw new LockedOutError(attempt.lockedForSeconds);
    }

    const user = await this.users.findById(session.user.id);
    if (!user) throw new UserNotFoundError(session.user.id);

    if (!(await verifyPassword(current, user.password_hash))) {
      attempt.fail();
      logger.warn(
        `[Auth] password change refused, wrong current password: ${user.username}`,
      );
      throw new InvalidCredentialsError();
    }
    attempt.succeed();

    const problem = passwordProblem(next, user.username);
    if (problem) throw new WeakPasswordError(problem);

    await this.credentials.changePassword(
      user.id,
      await hashPassword(next),
      session.tokenHash,
    );
    this.openStreams.closeUser(user.id, session.tokenHash);
    logger.info(`[Auth] password changed: ${user.username}`);
  }

  async deleteExpiredSessions(): Promise<number> {
    const now = new Date();
    return this.sessions.deleteExpired(now, idleSince(now));
  }

  /**
   * Closes the event streams whose session has run out, which is the only
   * thing that makes an expiry reach a page that is doing nothing but listen.
   *
   * A stream is deliberately not activity: it never touches `last_seen_at`, so
   * a page left open with only its streams running idles out after twelve
   * hours like any other session and is dropped here.
   */
  async closeStreamsOfEndedSessions(): Promise<number> {
    const watching = this.openStreams.openTokenHashes();
    if (watching.length === 0) return 0;

    const now = new Date();
    const live = await this.sessions.findLiveTokenHashes(
      watching,
      now,
      idleSince(now),
    );

    let closed = 0;
    for (const tokenHash of watching) {
      if (live.has(tokenHash)) continue;
      closed += this.openStreams.closeSession(tokenHash);
    }
    return closed;
  }
}
