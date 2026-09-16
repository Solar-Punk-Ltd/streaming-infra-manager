import type { SessionInfo, SignedInUser } from '../domain/auth/AuthService.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by requireSession. Absent on the handlers mounted ahead of it. */
      user?: SignedInUser;
      authSession?: SessionInfo;
    }
  }
}

export {};
