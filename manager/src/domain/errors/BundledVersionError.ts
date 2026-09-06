/**
 * The version the manager ships with is part of the image and its checkout is
 * replaced on every manager deploy, so it cannot be removed or rebuilt here.
 */
export class BundledVersionError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'BundledVersionError';
  }
}
