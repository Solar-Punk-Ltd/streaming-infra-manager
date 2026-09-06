/**
 * Reading a checkout's scripts proves the shape of a version and not that it
 * runs, so a version becomes the one new deployments are steered to only after
 * a person has deployed on it once and said so.
 */
export class UntestedVersionError extends Error {
  constructor(public readonly versionName: string) {
    super(
      `Mark ${versionName} as tested first, after one real deployment on it.`,
    );
    this.name = 'UntestedVersionError';
  }
}
