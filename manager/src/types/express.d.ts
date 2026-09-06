import type { SessionInfo, SignedInUser } from '../domain/auth/AuthService.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by requireSession. Absent on the two routes that stay open. */
      user?: SignedInUser;
      authSession?: SessionInfo;
    }
  }
}

export {};
