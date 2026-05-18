export class ProfileExistsError extends Error {
  constructor(public readonly profileName: string) {
    super(`Profile already exists: ${profileName}`);
    this.name = 'ProfileExistsError';
  }
}
