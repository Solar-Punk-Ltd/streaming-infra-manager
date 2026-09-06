export class LockedOutError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(`Too many sign-in attempts, retry in ${retryAfterSeconds}s`);
    this.name = 'LockedOutError';
  }
}
