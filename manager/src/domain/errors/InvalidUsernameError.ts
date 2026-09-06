export class InvalidUsernameError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'InvalidUsernameError';
  }
}
