/**
 * A sign-in that named no known user, or the wrong password for a known one.
 * Deliberately one error for both: telling them apart tells an attacker which
 * usernames exist.
 */
export class InvalidCredentialsError extends Error {
  constructor() {
    super('Wrong username or password');
    this.name = 'InvalidCredentialsError';
  }
}
