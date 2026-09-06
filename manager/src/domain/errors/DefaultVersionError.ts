/**
 * Removing the default would leave the table with no default at all, and the
 * partial unique index in migration 010 permits none rather than requiring one.
 * The next deployment would then be created with no version to run.
 */
export class DefaultVersionError extends Error {
  constructor(public readonly versionName: string) {
    super(`${versionName} is the default version. Set another default first.`);
    this.name = 'DefaultVersionError';
  }
}
