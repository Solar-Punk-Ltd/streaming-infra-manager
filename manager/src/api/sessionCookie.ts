import { SESSION_COOKIE_NAME } from '@streaming-infra-manager/common';
import { CookieOptions, Request, Response } from 'express';

import { parseCookies } from '../utils/cookies.js';

/**
 * `Secure` only when the browser really did use HTTPS: the TLS edge says so
 * with `X-Forwarded-Proto` and nginx passes it on, and a direct TLS connection
 * shows up as `req.secure`.
 *
 * It used to be set for any production build, and the image always is one. A
 * browser reaching the manager over plain HTTP at anything but localhost then
 * dropped the cookie it had just been given, so signing in came straight back
 * to the sign-in page with nothing to show for it.
 */
function isSecureRequest(req: Request): boolean {
  const header = req.headers['x-forwarded-proto'];
  const value = Array.isArray(header) ? header[0] : header;
  const edgeProtocol = value?.split(',')[0]?.trim().toLowerCase();

  return edgeProtocol === 'https' || req.secure;
}

function cookieOptions(req: Request): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isSecureRequest(req),
  };
}

/** The session token the browser sent, or null when it sent none. */
export function readSessionToken(req: Request): string | null {
  return parseCookies(req.headers.cookie).get(SESSION_COOKIE_NAME) ?? null;
}

export function setSessionCookie(
  req: Request,
  res: Response,
  token: string,
): void {
  res.cookie(SESSION_COOKIE_NAME, token, cookieOptions(req));
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, cookieOptions(req));
}
