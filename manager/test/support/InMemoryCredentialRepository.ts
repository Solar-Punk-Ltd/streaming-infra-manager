import type { CredentialRepository } from '../../src/domain/auth/CredentialRepository.js';

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

  async changePassword(
    userId: number,
    passwordHash: string,
    keepSessionTokenHash: string,
  ): Promise<void> {
    this.users.setPasswordHash(userId, passwordHash);
    this.sessions.deleteForUserExcept(userId, keepSessionTokenHash);
  }
}
