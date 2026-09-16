import { isTimeout } from '../../http';

/**
 * How long the New deployment dialog waits for the manager to answer a create.
 *
 * The request is not what does the work. `POST /profiles` answers 202 once the
 * deploy job has started, and the manager has already announced the new
 * deployment on the events stream before it answers, so by the time this
 * deadline passes the deployment is on the deployments page whatever the
 * request goes on to do. Giving up here therefore loses nothing.
 *
 * It exists because nothing else bounded the wait: the shared fetch helper sets
 * no timeout, and the dialog refused to close while a request was in flight, so
 * one request that never came back left the dialog with a dead close button and
 * a disabled Deploy button and no way out but a page reload.
 */
export const CREATE_TIMEOUT_MS = 60_000;

/** True for a request this dialog gave up on, rather than one the manager refused. */
export function isSubmissionTimeout(caught: unknown): boolean {
  return isTimeout(caught);
}

/**
 * Whether the deployments list has to be read again after a create that failed.
 *
 * A create that ran out of time may have been carried out anyway, and for a
 * pool nothing else brings it in: the events stream carries profile, engine,
 * version and attempt events and nothing about a group, so the four rungs turn
 * up on their own and the pool they belong to is absent from the page until
 * the list is read again.
 */
export function refreshAfterFailedCreate(caught: unknown): boolean {
  return isSubmissionTimeout(caught);
}

export function createTimedOutMessage(name: string): string {
  const seconds = Math.round(CREATE_TIMEOUT_MS / 1_000);
  return `The manager has not answered in ${seconds} seconds. ${name} may already have been created and may still be starting. Close this and check the deployments list before trying again.`;
}
