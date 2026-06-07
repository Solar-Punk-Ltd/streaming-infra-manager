/**
 * Raised when the per-profile bee node's HTTP API can't be reached or returns
 * an error. Mapped to HTTP 502 (the manager is fine; its upstream isn't).
 */
export class BeeNodeError extends Error {
  constructor(
    public readonly profileName: string,
    message: string,
  ) {
    super(message);
    this.name = 'BeeNodeError';
  }
}
