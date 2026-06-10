import {
  hasStampId,
  servicesNeedStamp,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

import { Profile } from '../types/index.js';

export {
  defaultServicesFor,
  hasStampId,
  isPendingStamp,
  servicesNeedStamp,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

export interface DeploySplit {
  deployNow: string[];
  heldBackForStamp: string[];
}

// Keeps deploy.sh's interactive STAMP prompt from firing under the stdin-less runner.
export function splitDeployableServices(
  profile: Profile,
  services: readonly string[],
): DeploySplit {
  if (hasStampId(profile) || !servicesNeedStamp(services)) {
    return { deployNow: [...services], heldBackForStamp: [] };
  }
  return {
    deployNow: services.filter(
      (service) => service !== STREAM_UPLOADER_SERVICE,
    ),
    heldBackForStamp: [STREAM_UPLOADER_SERVICE],
  };
}
