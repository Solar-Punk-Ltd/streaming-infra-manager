import { getErrorMessage } from '@streaming-infra-manager/common';

import { BeeHttpError } from './errors/BeeHttpError.js';
import { BeeNodeError } from './errors/BeeNodeError.js';
import { BeeNotReadyError } from './errors/BeeNotReadyError.js';

/** What Bee answers while it starts and syncs. */
const BEE_NOT_READY_STATUS = 503;

/**
 * What a failed call to a deployment's Bee node means for the caller.
 *
 * A 503 is the node itself saying it is not ready yet: it is up, it answered,
 * and it will serve the same call once it has synced. Everything else, a
 * refused connection or a timeout included, is the node being unreachable.
 * The two read the same in a log line and mean opposite things to the
 * operator, one is "wait a minute" and the other "go and look".
 */
export function beeCallFailed(profileName: string, err: unknown): Error {
  if (err instanceof BeeHttpError && err.status === BEE_NOT_READY_STATUS) {
    return new BeeNotReadyError(profileName);
  }
  return new BeeNodeError(profileName, getErrorMessage(err));
}
