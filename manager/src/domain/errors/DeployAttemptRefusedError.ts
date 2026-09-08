/** A deploy attempt that may not start now, because another holds its project or the daemon. */
export class DeployAttemptRefusedError extends Error {
  constructor(
    public readonly profileName: string,
    public readonly reason: string,
  ) {
    super(reason);
    this.name = 'DeployAttemptRefusedError';
  }
}
