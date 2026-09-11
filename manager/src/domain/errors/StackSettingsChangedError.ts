/**
 * A save made against a revision the version has moved past: another page, or
 * the editing script over ssh, committed in between. The current generation
 * travels with it so the page can say what to reload to.
 */
export class StackSettingsChangedError extends Error {
  constructor(
    public readonly versionName: string,
    public readonly generation: number,
  ) {
    super(
      `${versionName} settings changed since this page loaded: they are at revision ${generation} now. Reload, and make the change again.`,
    );
    this.name = 'StackSettingsChangedError';
  }
}
