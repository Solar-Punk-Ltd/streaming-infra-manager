/**
 * The Docker daemon did not answer inside the bound.
 *
 * A daemon that has stalled rather than refused leaves the socket open and says
 * nothing, so a request that waits on it waits until the browser gives up. A
 * gateway timeout is what that is: the manager is fine, the thing behind it is
 * not answering.
 */
export class DockerUnavailableError extends Error {
  constructor() {
    super('The Docker daemon did not answer in time. Try again in a moment.');
    this.name = 'DockerUnavailableError';
  }
}
