/** A Tested click made for a build the version has since moved past. */
export class StackVersionChangedError extends Error {
  constructor(
    public readonly versionName: string,
    public readonly commitSha: string | null,
    status: string,
  ) {
    const now =
      status === 'ready' && commitSha ? `at ${commitSha.slice(0, 7)}` : status;
    super(
      `${versionName} changed since this page loaded: it is now ${now}. Reload, and mark the build you actually tested.`,
    );
    this.name = 'StackVersionChangedError';
  }
}
