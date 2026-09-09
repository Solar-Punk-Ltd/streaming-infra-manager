export class ProfileInstanceChangedError extends Error {
  constructor(readonly profileName: string) {
    super('This deployment instance changed. Refresh before removing it.');
    this.name = 'ProfileInstanceChangedError';
  }
}
