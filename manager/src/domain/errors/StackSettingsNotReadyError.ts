/**
 * The settings of a version that has nothing to show yet. They are seeded from
 * the samples by the version's first build, so a version that has never
 * finished one has no files and no descriptions to put on a page.
 */
export class StackSettingsNotReadyError extends Error {
  constructor(public readonly versionName: string, public readonly reason: string) {
    super(`${versionName} has no settings yet. ${reason}`);
    this.name = 'StackSettingsNotReadyError';
  }
}
