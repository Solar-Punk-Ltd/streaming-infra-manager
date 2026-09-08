export class ProfileInstanceChangedError extends Error {
  constructor(readonly profileName: string) {
    super('This deployment instance changed. Refresh before changing it.');
    this.name = 'ProfileInstanceChangedError';
  }
}
