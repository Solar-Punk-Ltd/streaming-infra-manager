import {
  getErrorMessage,
  type ReadFailure,
  type ReadFailureReason,
} from '@streaming-infra-manager/common';

import { BeeHttpError } from './errors/BeeHttpError.js';

/**
 * A call to a bee node, with how long it ran, whichever way it ended.
 *
 * The elapsed time is the half of a failure an operator can act on: a read
 * that gave up after three seconds and one that was refused in four
 * milliseconds are the same null on the page and two different jobs.
 */
export type NodeRead<T> =
  | { ok: true; value: T; elapsedMs: number }
  | { ok: false; error: unknown; elapsedMs: number };

export async function readNode<T>(
  call: () => Promise<T>,
): Promise<NodeRead<T>> {
  const started = Date.now();
  try {
    return { ok: true, value: await call(), elapsedMs: Date.now() - started };
  } catch (error) {
    return { ok: false, error, elapsedMs: Date.now() - started };
  }
}

/** The reason, where there is one: a read that succeeded has nothing to say. */
export function failureOf(read: NodeRead<unknown>): ReadFailure | undefined {
  return read.ok ? undefined : readFailureFrom(read.error, read.elapsedMs);
}

export function readFailureFrom(
  error: unknown,
  elapsedMs: number,
): ReadFailure {
  return { reason: reasonOf(error), elapsedMs };
}

// BeeClient flattens whatever fetch threw into the text of a plain Error, so
// the words are all that is left to tell a budget that ran out from a socket
// nothing answered on.
const RAN_OUT_OF_TIME = /timeout|timed out|aborted/i;
const COULD_NOT_BE_READ = /non-JSON|JSON/i;

function reasonOf(error: unknown): ReadFailureReason {
  if (error instanceof BeeHttpError) return 'refused';
  const message = getErrorMessage(error);
  if (RAN_OUT_OF_TIME.test(message)) return 'timeout';
  if (COULD_NOT_BE_READ.test(message)) return 'malformed';
  return 'unreachable';
}
