/**
 * The deployment's Bee node answered, but with 503: it is up and still
 * starting or syncing, and will serve the same call once it has caught up.
 * Not the same as unreachable, which is what a refused connection means.
 */
export class BeeNotReadyError extends Error {
  constructor(public readonly profileName: string) {
    super(
      'the Bee node is still starting and answers 503 until it has synced, usually within a minute',
    );
    this.name = 'BeeNotReadyError';
  }
}
