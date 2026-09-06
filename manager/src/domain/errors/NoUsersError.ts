/** Nobody has been created yet, so there is no password to check against. */
export class NoUsersError extends Error {
  constructor() {
    super('No users exist yet, create the first one on the host');
    this.name = 'NoUsersError';
  }
}
