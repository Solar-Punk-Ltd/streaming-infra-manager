/** A deploy target whose daemon the manager has not established, so it can reserve no port for it. */
export class TargetNotVerifiedError extends Error {
  constructor(public readonly alias: string) {
    super(
      `Deploy target ${alias} is not verified, so the manager cannot tell which daemon its ports belong to and reserves none. Verify it first.`,
    );
    this.name = 'TargetNotVerifiedError';
  }
}
