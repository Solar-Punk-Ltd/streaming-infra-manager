/** Removing yourself, or the last user, would lock everyone out. */
export class CannotRemoveUserError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'CannotRemoveUserError';
  }
}
