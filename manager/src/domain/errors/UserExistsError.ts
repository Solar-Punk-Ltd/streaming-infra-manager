export class UserExistsError extends Error {
  constructor(public readonly username: string) {
    super(`User already exists: ${username}`);
    this.name = 'UserExistsError';
  }
}
