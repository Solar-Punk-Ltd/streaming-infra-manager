/**
 * The sign-in rules and shapes that the manager, the frontend and the offline
 * mock all have to agree on.
 *
 * Each of these was written out three times before it lived here, and a copy
 * that drifts is not a compile error anywhere: the UI would accept a password
 * the manager refuses, the mock would lock out on a different count than the
 * real thing, and the header that makes a cross-site write impossible would be
 * spelled one way on the sending side and another on the checking side.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** The authenticated account as returned by `GET /auth/session`. */
export interface SessionInfo {
  id: number;
  username: string;
  isAdmin: boolean;
  /** ISO session expiry. No session token is included. */
  expiresAt: string;
}

/** One row of the Access page's user table, as `GET /auth/users` answers it. */
export interface UserSummary {
  id: number;
  username: string;
  /** May add and remove users and sign anyone out. */
  isAdmin: boolean;
  /** ISO. */
  createdAt: string;
  /** ISO, or null for a user who has never signed in. */
  lastLoginAt: string | null;
  sessions: number;
}

// ------------------------------------------------------------- the password

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * The one authority on what makes an acceptable password. Returns the reason it
 * is refused, in words the operator can act on, or null when it is fine.
 *
 * Anything printable is allowed and no composition rules apply: length is the
 * only thing that buys resistance to guessing, and a password that carries the
 * username is the first guess anyone makes.
 */
export function passwordProblem(
  password: string,
  username: string,
): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  if (
    username.length > 0 &&
    password.toLowerCase().includes(username.toLowerCase())
  ) {
    return 'password must not contain the username';
  }
  return null;
}

// ------------------------------------------------------------- the username

/** Mirrors the users_username_format CHECK in 008_auth.sql. */
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export const USERNAME_MAX_LENGTH = 32;

export const USERNAME_MESSAGE =
  'username must be 2 to 32 characters of a-z, 0-9, dot, underscore or dash, starting with a letter or digit';

/**
 * The reason a username cannot be used, or null when it can.
 *
 * The database enforces the same rule as a CHECK constraint. This exists so a
 * bad name is refused with something an operator can act on, rather than
 * arriving as a constraint violation from the driver.
 */
export function usernameProblem(username: string): string | null {
  return USERNAME_RE.test(username) ? null : USERNAME_MESSAGE;
}

// ------------------------------------------------------ the request headers

export const SESSION_COOKIE_NAME = 'sim_session';

export const REQUESTED_WITH_HEADER = 'x-requested-with';

/**
 * A header no cross-origin page can add without a CORS preflight, which this
 * API never answers. The frontend's fetch wrapper puts it on every write.
 */
export const REQUESTED_WITH_VALUE = 'streaming-infra-manager';

// ----------------------------------------------------------- the two clocks

/** Signed out after this long without a request. Slides on every request. */
export const SESSION_IDLE_TIMEOUT_MS = 12 * HOUR_MS;

/** Signed out this long after signing in, however busy the session was. */
export const SESSION_ABSOLUTE_TIMEOUT_MS = 14 * 24 * HOUR_MS;

// -------------------------------------------------------- the lockout schedule

/** Failures allowed before the first lockout. The next one locks. */
export const LOGIN_FREE_ATTEMPTS = 4;

export const LOGIN_FIRST_LOCKOUT_MS = MINUTE_MS;
export const LOGIN_MAX_LOCKOUT_MS = 60 * MINUTE_MS;

/** How long a key is locked after this many failures, and 0 while it is free. */
export function lockoutMsFor(failures: number): number {
  if (failures <= LOGIN_FREE_ATTEMPTS) return 0;

  const doublings = failures - LOGIN_FREE_ATTEMPTS - 1;
  return Math.min(
    LOGIN_MAX_LOCKOUT_MS,
    LOGIN_FIRST_LOCKOUT_MS * 2 ** doublings,
  );
}
