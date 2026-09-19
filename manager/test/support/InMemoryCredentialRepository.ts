import type { CredentialRepository } from '../../src/domain/auth/CredentialRepository.js';
import type { NewSession } from '../../src/domain/auth/SessionRepository.js';

import type { InMemorySessionRepository } from './InMemorySessionRepository.js';
import type { InMemoryUserRepository } from './InMemoryUserRepository.js';

/**
 * The password change without Postgres, for the tests.
 *
 * It reaches into both in-memory tables because that is what the one
 * transaction in the Postgres version does, and neither write can be observed
 * between the two: nothing here awaits.
 */
export class InMemoryCredentialRepository implements CredentialRepository {
  constructor(
    private readonly users: InMemoryUserRepository,
    private readonly sessions: InMemorySessionRepository,
  ) {}

  async admitSession(
    userId: number,
    verifiedPasswordHash: string,
    session: NewSession,
    signedInAt: Date,
  ): Promise<boolean> {
    if (!this.users.passwordHashIs(userId, verifiedPasswordHash)) return false;
    await this.sessions.create(session);
    await this.users.markSignedIn(userId, signedInAt);
    return true;
  }

  async changePassword(
    userId: number,
    verifiedPasswordHash: string,
    passwordHash: string,
    keepSessionTokenHash: string,
  ): Promise<boolean> {
    if (!this.users.passwordHashIs(userId, verifiedPasswordHash)) return false;
    this.users.setPasswordHash(userId, passwordHash);
    this.sessions.deleteForUserExcept(userId, keepSessionTokenHash);
    return true;
  }
}
