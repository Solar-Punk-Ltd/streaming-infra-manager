/**
 * Raised when an action requires a usable postage stamp but the profile has
 * none yet (e.g. "deploy uploader" before a stamp is provided or bought).
 */
export class StampRequiredError extends Error {
  constructor(public readonly profileName: string) {
    super(`Profile ${profileName} needs a usable postage stamp first`);
    this.name = 'StampRequiredError';
  }
}
