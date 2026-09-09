/**
 * Signing in, for the mock manager.
 *
 * It behaves the way `manager/src/domain/auth` behaves, so the whole flow is
 * playable offline: one session cookie on the same two clocks, the same lockout
 * schedule, the same refusal of a write that arrives without the header, and
 * the same answers when no user exists or an id names nobody. Passwords are kept in memory as typed, because nothing
 * here ever leaves this machine and the point of the file is the flow.
 *
 * Two differences from the real manager, both deliberate:
 *   - removing the last user is allowed, so the "no users yet" state can be
 *     seen without editing this file. The real manager answers 409.
 *   - there is no CLI, so the first user is the seeded one below.
 */
import { randomBytes } from 'node:crypto';

import {
  lockoutMsFor,
  passwordProblem,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_TIMEOUT_MS,
  usernameProblem,
} from '@streaming-infra-manager/common';

import { parseCookies, send, sendEmpty } from './mock-http.mjs';

/** The offline login. A fixture, not a secret: it opens nothing but this mock. */
export const DEV_USERNAME = 'dev';
export const DEV_PASSWORD = 'dev-password-1234';

/** What the manager answers a user who cannot manage users. */
const ADMIN_REQUIRED = {
  error: 'admin_required',
  message: 'Only a user who can manage users may do this.',
};

const state = {
  users: [],
  nextUserId: 1,
  /** token -> { userId, expiresAt, absoluteExpiresAt } */
  sessions: new Map(),
  /** limiter key -> { failures, lockedUntil } */
  attempts: new Map(),
};

function addUser(username, password, admin = false) {
  const user = {
    id: state.nextUserId++,
    username,
    password,
    // The first user can manage users whatever was asked, as on the manager.
    isAdmin: admin || state.users.length === 0,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  };
  state.users.push(user);
  return user;
}

export function seedAuth() {
  state.users = [];
  state.nextUserId = 1;
  state.sessions.clear();
  state.attempts.clear();
  addUser(DEV_USERNAME, DEV_PASSWORD);
}

// ------------------------------------------------------------- the limiter

function retryAfterSeconds(key) {
  const entry = state.attempts.get(key);
  if (!entry || entry.lockedUntil <= Date.now()) return 0;
  return Math.ceil((entry.lockedUntil - Date.now()) / 1000);
}

function recordFailure(key) {
  const failures = (state.attempts.get(key)?.failures ?? 0) + 1;
  state.attempts.set(key, {
    failures,
    lockedUntil: Date.now() + lockoutMsFor(failures),
  });
}

// ------------------------------------------------------------- the session

function cookieHeader(token) {
  const attributes = 'HttpOnly; SameSite=Lax; Path=/';
  return token === null
    ? `${SESSION_COOKIE_NAME}=; ${attributes}; Max-Age=0`
    : `${SESSION_COOKIE_NAME}=${token}; ${attributes}`;
}

function tokenOf(req) {
  return parseCookies(req.headers.cookie).get(SESSION_COOKIE_NAME) ?? null;
}

/** When a session stops working if nothing else touches it. */
function endsAt(session) {
  return Math.min(session.expiresAt, session.absoluteExpiresAt);
}

function isLive(session) {
  return endsAt(session) > Date.now();
}

/** The signed-in user and their session, or null. Slides the idle window. */
function signedIn(req) {
  const token = tokenOf(req);
  const session = token ? state.sessions.get(token) : null;
  if (!session) return null;

  if (!isLive(session)) {
    state.sessions.delete(token);
    return null;
  }

  session.expiresAt = Date.now() + SESSION_IDLE_TIMEOUT_MS;
  const user = state.users.find((entry) => entry.id === session.userId);
  return user ? { user, session } : null;
}

export function userFor(req) {
  return signedIn(req)?.user ?? null;
}

function sessionsOf(userId) {
  let count = 0;
  for (const session of state.sessions.values()) {
    if (session.userId === userId && isLive(session)) count += 1;
  }
  return count;
}

function exists(userId) {
  return state.users.some((user) => user.id === userId);
}

function summarise(user) {
  return {
    id: user.id,
    username: user.username,
    isAdmin: user.isAdmin,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    sessions: sessionsOf(user.id),
  };
}

// --------------------------------------------------------------- the guard

const OPEN_ROUTES = [
  ['GET', /^\/health$/],
  ['POST', /^\/auth\/login$/],
  ['GET', /^\/auth\/session$/],
];

/**
 * Answers the request itself when it must be refused, and returns true when it
 * did. Mirrors requireSameSite and requireSession in the manager.
 */
export function refuseRequest(req, res, path) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    const crossSite =
      req.headers['sec-fetch-site'] === 'cross-site' ||
      (origin !== undefined && originHost(origin) !== req.headers.host) ||
      req.headers[REQUESTED_WITH_HEADER] !== REQUESTED_WITH_VALUE;

    if (crossSite) {
      send(res, 403, { error: 'cross_site_request' });
      return true;
    }
  }

  const isOpen = OPEN_ROUTES.some(
    ([method, pattern]) => method === req.method && pattern.test(path),
  );
  if (isOpen || userFor(req)) return false;

  // A cookie that no longer opens anything is cleared, as the manager does.
  const headers = tokenOf(req) ? { 'set-cookie': cookieHeader(null) } : {};
  send(res, 401, { error: 'not_signed_in' }, headers);
  return true;
}

function originHost(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------- the routes

export function authRoutes(readBody) {
  return [
    [
      'POST',
      /^\/auth\/login$/,
      async (req, res) => {
        if (state.users.length === 0) {
          return send(res, 409, { error: 'no_users' });
        }

        const body = await readBody(req);
        const username = String(body.username ?? '');
        const keys = [`username:${username.toLowerCase()}`, 'ip:mock'];
        const wait = Math.max(...keys.map(retryAfterSeconds));
        if (wait > 0) {
          return send(
            res,
            429,
            { error: 'locked_out', retryAfterSeconds: wait },
            { 'retry-after': String(wait) },
          );
        }

        const user = state.users.find((entry) => entry.username === username);
        if (!user || user.password !== body.password) {
          for (const key of keys) recordFailure(key);
          return send(res, 401, { error: 'invalid_credentials' });
        }

        state.attempts.delete(keys[0]);
        user.lastLoginAt = new Date().toISOString();
        const token = randomBytes(32).toString('base64url');
        state.sessions.set(token, {
          userId: user.id,
          expiresAt: Date.now() + SESSION_IDLE_TIMEOUT_MS,
          absoluteExpiresAt: Date.now() + SESSION_ABSOLUTE_TIMEOUT_MS,
        });
        sendEmpty(res, 204, { 'set-cookie': cookieHeader(token) });
      },
    ],
    [
      'GET',
      /^\/auth\/session$/,
      (req, res) => {
        const open = signedIn(req);
        if (open) {
          return send(res, 200, {
            id: open.user.id,
            username: open.user.username,
            isAdmin: open.user.isAdmin,
            expiresAt: new Date(endsAt(open.session)).toISOString(),
          });
        }
        send(res, 401, {
          error: state.users.length === 0 ? 'no_users' : 'not_signed_in',
        });
      },
    ],
    [
      'POST',
      /^\/auth\/logout$/,
      (req, res) => {
        const token = tokenOf(req);
        if (token) state.sessions.delete(token);
        sendEmpty(res, 204, { 'set-cookie': cookieHeader(null) });
      },
    ],
    [
      'POST',
      /^\/auth\/password$/,
      async (req, res) => {
        const user = userFor(req);
        const body = await readBody(req);
        if (user.password !== body.current) {
          return send(res, 401, { error: 'invalid_credentials' });
        }

        const problem = passwordProblem(String(body.next ?? ''), user.username);
        if (problem) {
          return send(res, 400, { error: 'validation_error', errors: [problem] });
        }

        user.password = body.next;
        const own = tokenOf(req);
        for (const [token, session] of state.sessions) {
          if (session.userId === user.id && token !== own) {
            state.sessions.delete(token);
          }
        }
        sendEmpty(res, 204);
      },
    ],
    [
      'GET',
      /^\/auth\/users$/,
      (_req, res) => send(res, 200, state.users.map(summarise)),
    ],
    [
      'POST',
      /^\/auth\/users$/,
      async (req, res) => {
        if (!userFor(req).isAdmin) return send(res, 403, ADMIN_REQUIRED);
        const body = await readBody(req);
        const username = String(body.username ?? '');
        const badName = usernameProblem(username);
        if (badName) {
          return send(res, 400, { error: 'validation_error', errors: [badName] });
        }
        if (state.users.some((entry) => entry.username === username)) {
          return send(res, 409, { error: 'user_exists', username });
        }

        const problem = passwordProblem(String(body.password ?? ''), username);
        if (problem) {
          return send(res, 400, { error: 'validation_error', errors: [problem] });
        }

        send(
          res,
          201,
          summarise(addUser(username, body.password, body.admin === true)),
        );
      },
    ],
    [
      'DELETE',
      /^\/auth\/users\/(\d+)$/,
      (req, res, [id]) => {
        const userId = Number(id);
        if (!userFor(req).isAdmin) return send(res, 403, ADMIN_REQUIRED);
        if (userFor(req).id === userId && state.users.length > 1) {
          return send(res, 409, {
            error: 'cannot_remove_user',
            message: 'You cannot remove your own account. Ask another user to remove it.',
          });
        }
        if (!exists(userId)) {
          return send(res, 404, { error: 'user_not_found', id: userId });
        }

        state.users = state.users.filter((entry) => entry.id !== userId);
        for (const [token, session] of state.sessions) {
          if (session.userId === userId) state.sessions.delete(token);
        }
        sendEmpty(res, 204);
      },
    ],
    [
      'POST',
      /^\/auth\/users\/(\d+)\/revoke-sessions$/,
      (req, res, [id]) => {
        const userId = Number(id);
        const actor = userFor(req);
        if (!actor.isAdmin && actor.id !== userId) {
          return send(res, 403, ADMIN_REQUIRED);
        }
        if (!exists(userId)) {
          return send(res, 404, { error: 'user_not_found', id: userId });
        }

        for (const [token, session] of state.sessions) {
          if (session.userId === userId) state.sessions.delete(token);
        }
        sendEmpty(res, 204);
      },
    ],
  ];
}
