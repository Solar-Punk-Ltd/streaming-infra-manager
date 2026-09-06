export class UserNotFoundError extends Error {
  constructor(public readonly userId: number) {
    super(`User not found: ${userId}`);
    this.name = 'UserNotFoundError';
  }
}
