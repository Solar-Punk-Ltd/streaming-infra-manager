/**
 * A second restart of the same container, while the first is still landing.
 *
 * A container takes several seconds to come back and reads as down for part of
 * that, which is exactly when an operator presses the button again. Restarting
 * on top of a restart leaves compose and the daemon disagreeing about what is
 * running, and the answer the operator wanted is a few seconds of patience.
 */
export class RestartInProgressError extends Error {
  constructor(
    public readonly profileName: string,
    public readonly service: string,
  ) {
    super(
      `${service} on ${profileName} was restarted a moment ago. ` +
        'Wait a few seconds, then try again.',
    );
    this.name = 'RestartInProgressError';
  }
}
