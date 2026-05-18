export class ProfileNotFoundError extends Error {
  constructor(public readonly profileName: string) {
    super(`Profile not found: ${profileName}`);
    this.name = 'ProfileNotFoundError';
  }
}
