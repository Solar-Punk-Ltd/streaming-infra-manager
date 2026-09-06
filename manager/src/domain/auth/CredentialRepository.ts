/**
 * The writes that change a password, as one step.
 *
 * Setting the hash and dropping the user's other sessions used to be two
 * statements. If the second one failed the password had changed and the
 * sessions it was being changed because of were still open, which is the exact
 * situation the "your other browsers were signed out" promise rules out.
 */
export interface CredentialRepository {
  /**
   * Sets the password hash and deletes every session of the user except the
   * one making the change, atomically.
   */
  changePassword(
    userId: number,
    passwordHash: string,
    keepSessionTokenHash: string,
  ): Promise<void>;
}
