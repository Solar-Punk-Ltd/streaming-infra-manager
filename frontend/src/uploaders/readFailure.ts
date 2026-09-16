import type { ReadFailure, ReadFailureReason } from '@streaming-infra-manager/common';

import { ApiError, isTimeout } from '../http';

/** The manager's code for a node that answered 503: up, still syncing. */
export const NODE_NOT_READY_CODE = 'bee_node_not_ready';

/**
 * Why a node reading the page asked for is missing, worked out from what the
 * fetch threw.
 *
 * These routes do not answer 200 with a null in them. A bee call the manager
 * could not complete becomes a status of its own, 503 where the node answered
 * and refused and 502 where it could not be reached, so a rejected fetch here
 * is the node far more often than the manager. That is what makes it fair to
 * put the answer through the same four reasons the readiness list spells.
 *
 * Anything it cannot place is `unreachable`, which says the page got no answer
 * without claiming the node gave one.
 */
export function readFailureFrom(
  caught: unknown,
  elapsedMs: number,
): ReadFailure {
  return { reason: reasonOf(caught), elapsedMs };
}

function reasonOf(caught: unknown): ReadFailureReason {
  if (isTimeout(caught)) return 'timeout';
  if (caught instanceof SyntaxError) return 'malformed';
  if (caught instanceof ApiError) {
    return caught.code === NODE_NOT_READY_CODE ? 'refused' : 'unreachable';
  }
  return 'unreachable';
}
