import { Request, RequestHandler } from 'express';

import type {
  AuthService,
  SessionInfo,
  SignedInUser,
} from '../../domain/auth/AuthService.js';
import {
  AdminRequiredError,
  NotSignedInError,
} from '../../domain/errors/index.js';
import { clearSessionCookie, readSessionToken } from '../sessionCookie.js';

import { asyncHandler } from './asyncHandler.js';

/**
 * The gate. Everything mounted after it needs a live session, and gets
 * `req.user` and `req.authSession` to work from.
 *
 * A cookie that no longer opens anything is cleared on the way out, so a
 * browser that has been away for a fortnight stops sending a dead token.
 */
export function createRequireSession(authService: AuthService): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    const token = readSessionToken(req);
    const session = token ? await authService.sessionFor(token) : null;

    if (!session) {
      if (token) clearSessionCookie(req, res);
      next(new NotSignedInError());
      return;
    }

    req.authSession = session;
    req.user = session.user;
    next();
  });
}

/** The session on a request that came through `requireSession`. */
export function signedInSession(req: Request): SessionInfo {
  if (!req.authSession) throw new NotSignedInError();
  return req.authSession;
}

export function signedInUser(req: Request): SignedInUser {
  return signedInSession(req).user;
}

/** Mounted after `requireSession`: refuses anyone who cannot manage users. */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  next(signedInUser(req).isAdmin ? undefined : new AdminRequiredError());
};
