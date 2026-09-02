import {
  hasBeePublishers,
  hasStampId,
  servicesNeedStamp,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

import { Profile } from '../types/index.js';

export {
  defaultServicesFor,
  hasBeePublishers,
  hasStampId,
  isPendingStamp,
  servicesNeedStamp,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

export interface DeploySplit {
  deployNow: string[];
  heldBackForStamp: string[];
}

// Keeps deploy.sh's interactive STAMP prompt from firing under the stdin-less
// runner. A pool-backed uploader (BEE_PUBLISHERS set) carries no STAMP of its
// own and is released here; deploy.sh's check_stamp has to accept BEE_PUBLISHERS
// as satisfying it (a swarm-hls-stream change), or the prompt fires anyway.
export function splitDeployableServices(
  profile: Profile,
  services: readonly string[],
): DeploySplit {
  if (
    hasStampId(profile) ||
    hasBeePublishers(profile) ||
    !servicesNeedStamp(services)
  ) {
    return { deployNow: [...services], heldBackForStamp: [] };
  }
  return {
    deployNow: services.filter(
      (service) => service !== STREAM_UPLOADER_SERVICE,
    ),
    heldBackForStamp: [STREAM_UPLOADER_SERVICE],
  };
}
