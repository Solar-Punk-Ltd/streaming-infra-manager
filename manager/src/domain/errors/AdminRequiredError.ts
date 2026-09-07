/** A user who cannot manage users tried to. Answered 403. */
export class AdminRequiredError extends Error {
  constructor() {
    super('Only a user who can manage users may do this.');
    this.name = 'AdminRequiredError';
  }
}
