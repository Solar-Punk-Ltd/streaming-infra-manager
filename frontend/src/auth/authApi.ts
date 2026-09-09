import type { SessionInfo, UserSummary } from '@streaming-infra-manager/common';

import { apiFetch, failWith, getJson, send } from '../http';

import { SIGN_IN_MESSAGES, tooManyAttempts } from './messages';

export type { SessionInfo } from '@streaming-infra-manager/common';

export type SignedOutReason =
  | 'notSignedIn'
  | 'noUsers'
  | 'ended'
  | 'unreachable';

export type SessionProbe =
  | { signedIn: true; session: SessionInfo }
  | { signedIn: false; reason: SignedOutReason };

export type SignInResult = { ok: true } | { ok: false; message: string };

const LOCKOUT_FALLBACK_SECONDS = 60;

async function retryAfterOf(res: Response): Promise<number> {
  const header = Number(res.headers.get('retry-after'));
  try {
    const body = (await res.json()) as { retryAfterSeconds?: number };
    if (body.retryAfterSeconds) return body.retryAfterSeconds;
  } catch {
    /* the header below is the fallback */
  }
  return Number.isFinite(header) && header > 0
    ? header
    : LOCKOUT_FALLBACK_SECONDS;
}

/**
 * Who is signed in, asked once on boot.
 *
 * 401 is an answer here rather than a session ending, and its body separates
 * "nobody is signed in" from "no user has been created yet", which are two
 * very different things to tell whoever is looking at the screen.
 */
export async function probeSession(): Promise<SessionProbe> {
  try {
    const res = await apiFetch('/auth/session', { allowUnauthorized: true });

    if (res.ok) {
      return { signedIn: true, session: (await res.json()) as SessionInfo };
    }
    if (res.status === 401) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return {
        signedIn: false,
        reason: body.error === 'no_users' ? 'noUsers' : 'notSignedIn',
      };
    }
    return { signedIn: false, reason: 'unreachable' };
  } catch {
    return { signedIn: false, reason: 'unreachable' };
  }
}

export async function signIn(
  username: string,
  password: string,
): Promise<SignInResult> {
  let res: Response;
  try {
    res = await apiFetch('/auth/login', {
      method: 'POST',
      body: { username, password },
      allowUnauthorized: true,
    });
  } catch {
    return { ok: false, message: SIGN_IN_MESSAGES.unreachable };
  }

  if (res.ok) return { ok: true };
  if (res.status === 401) {
    return { ok: false, message: SIGN_IN_MESSAGES.wrongPair };
  }
  if (res.status === 429) {
    return { ok: false, message: tooManyAttempts(await retryAfterOf(res)) };
  }
  if (res.status === 409) {
    return { ok: false, message: SIGN_IN_MESSAGES.noUsers };
  }
  return { ok: false, message: SIGN_IN_MESSAGES.unreachable };
}

export function signOut(): Promise<void> {
  return send('POST', '/auth/logout', {});
}

export function fetchUsers(): Promise<UserSummary[]> {
  return getJson<UserSummary[]>('/auth/users');
}

export function addUser(
  username: string,
  password: string,
  admin: boolean,
): Promise<void> {
  return send('POST', '/auth/users', { username, password, admin });
}

export function removeUser(id: number): Promise<void> {
  return send('DELETE', `/auth/users/${id}`);
}

export function revokeSessions(id: number): Promise<void> {
  return send('POST', `/auth/users/${id}/revoke-sessions`, {});
}

/**
 * A 401 here means the current password was wrong, not that the session has
 * gone, so it is answered rather than turned into a sign-out.
 */
export async function changePassword(
  current: string,
  next: string,
): Promise<void> {
  const res = await apiFetch('/auth/password', {
    method: 'POST',
    body: { current, next },
    allowUnauthorized: true,
  });

  if (res.status === 401) throw new Error('That is not your current password.');
  if (!res.ok) await failWith(res, 'Could not change the password.');
}
