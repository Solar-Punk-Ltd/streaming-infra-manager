import type { NewSession } from './SessionRepository.js';

/**
 * Credential-gated session and password writes.
 *
 * Password verification is deliberately outside this repository because it is
 * expensive. Each write compares the verified snapshot again while holding
 * the user row lock, so a password replacement cannot race that verification.
 */
export interface CredentialRepository {
  /**
   * Creates the session and records the login only if the verified password
   * hash is still current.
   */
  admitSession(
    userId: number,
    verifiedPasswordHash: string,
    session: NewSession,
    signedInAt: Date,
  ): Promise<boolean>;
  /**
   * Sets the password hash and deletes every other session atomically, only if
   * the verified password hash is still current.
   */
  changePassword(
    userId: number,
    verifiedPasswordHash: string,
    passwordHash: string,
    keepSessionTokenHash: string,
  ): Promise<boolean>;
}
