import { Request, RequestHandler, Response, Router } from 'express';

import { AuthService } from '../../domain/auth/AuthService.js';
import {
  ChangePasswordBody,
  CreateUserBody,
  LoginBody,
  changePasswordSchema,
  createUserSchema,
  loginSchema,
  userIdParamSchema,
} from '../../schemas/auth.js';
import { clientIpOf } from '../../utils/clientIp.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { signedInSession, signedInUser } from '../middleware/requireSession.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import {
  clearSessionCookie,
  readSessionToken,
  setSessionCookie,
} from '../sessionCookie.js';

/** Kept for the session row, so a revoke can be told which browser it drops. */
const USER_AGENT_MAX_LENGTH = 255;

function userAgentOf(req: Request): string | null {
  const header = req.headers['user-agent'];
  const value = Array.isArray(header) ? header[0] : header;
  return value ? value.slice(0, USER_AGENT_MAX_LENGTH) : null;
}

function userIdOf(req: Request): number {
  return Number.parseInt(req.params.id as string, 10);
}

/**
 * Signing in, signing out, and who may do either.
 *
 * `POST /login` and `GET /session` are the only routes in the manager that
 * answer without a session, and `/session` answers 401 either way: it exists so
 * the frontend can tell "signed out" from "no users have been created yet".
 */
export function createAuthRouter(
  authService: AuthService,
  requireSession: RequestHandler,
): Router {
  const router = Router();

  router.post(
    '/login',
    validateBody(loginSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as LoginBody;
      const { token } = await authService.signIn({
        username: body.username,
        password: body.password,
        ip: clientIpOf(req),
        userAgent: userAgentOf(req),
      });
      setSessionCookie(req, res, token);
      res.status(204).end();
    }),
  );

  router.get(
    '/session',
    asyncHandler(async (req: Request, res: Response) => {
      const token = readSessionToken(req);
      const session = token ? await authService.sessionFor(token) : null;

      if (session) {
        res.json({
          username: session.user.username,
          expiresAt: session.expiresAt.toISOString(),
        });
        return;
      }

      if (token) clearSessionCookie(req, res);
      const error =
        (await authService.countUsers()) === 0 ? 'no_users' : 'not_signed_in';
      res.status(401).json({ error });
    }),
  );

  router.post(
    '/logout',
    requireSession,
    asyncHandler(async (req: Request, res: Response) => {
      await authService.signOut(signedInSession(req));
      clearSessionCookie(req, res);
      res.status(204).end();
    }),
  );

  router.post(
    '/password',
    requireSession,
    validateBody(changePasswordSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as ChangePasswordBody;
      await authService.changePassword(
        signedInSession(req),
        body.current,
        body.next,
      );
      res.status(204).end();
    }),
  );

  router.get(
    '/users',
    requireSession,
    asyncHandler(async (_req: Request, res: Response) => {
      res.json(await authService.listUsers());
    }),
  );

  router.post(
    '/users',
    requireSession,
    validateBody(createUserSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body as CreateUserBody;
      res.status(201).json(await authService.addUser(body.username, body.password));
    }),
  );

  router.delete(
    '/users/:id',
    requireSession,
    validateParams(userIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      await authService.removeUser(userIdOf(req), signedInUser(req).id);
      res.status(204).end();
    }),
  );

  router.post(
    '/users/:id/revoke-sessions',
    requireSession,
    validateParams(userIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      await authService.revokeSessions(userIdOf(req));
      res.status(204).end();
    }),
  );

  return router;
}
