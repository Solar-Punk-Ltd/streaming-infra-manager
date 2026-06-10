export class StampRequiredError extends Error {
  constructor(public readonly profileName: string) {
    super(`Profile ${profileName} needs a usable postage stamp first`);
    this.name = 'StampRequiredError';
  }
}
