import { servicesNeedStamp } from '@streaming-infra-manager/common';

import type { Profile } from '../types';
import { servicesOf } from './shape';

/**
 * What a batch newly set on this deployment reaches, and when, or null where
 * nothing is left to do once it is set.
 *
 * Setting a batch writes the deployment's record and starts nothing. A stamp
 * reaches an uploader through the env file written when the deployment is
 * deployed, and the uploader reads it once, when it starts, so one already
 * running goes on paying with the old batch. A pool rung's batch reaches its ABR
 * uploader through the pool string, which is copied into that uploader rather
 * than read from the rung. Saving an edit redeploys, but the drawer saves only
 * a change, so Stop and Start is what deploys a stream again as it stands.
 *
 * @param rung the ABR rung this deployment publishes, when it is a pool member.
 */
export function newBatchReach(profile: Profile, rung: string | null | undefined): string | null {
  if (rung) {
    return 'The pool string then names it, and an ABR uploader publishing to this pool goes on paying with the old batch until the new string is pasted into its Node pool string under Edit.';
  }
  if (servicesNeedStamp(servicesOf(profile))) {
    return 'An uploader already running goes on paying with the old batch until this deployment is deployed again: Stop it, then Start it.';
  }
  return null;
}
