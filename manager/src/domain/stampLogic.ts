import {
  hasUsableStamp,
  servicesNeedStamp,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

import { Profile } from '../types/index.js';

export {
  defaultServicesFor,
  hasUsableStamp,
  isPendingStamp,
  servicesNeedStamp,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

export interface DeploySplit {
  deploy: string[];
  heldBack: string[];
}

// Keeps deploy.sh's interactive STAMP prompt from firing under the stdin-less runner.
export function splitDeployableServices(
  profile: Profile,
  services: readonly string[],
): DeploySplit {
  if (hasUsableStamp(profile) || !servicesNeedStamp(services)) {
    return { deploy: [...services], heldBack: [] };
  }
  return {
    deploy: services.filter((service) => service !== STREAM_UPLOADER_SERVICE),
    heldBack: [STREAM_UPLOADER_SERVICE],
  };
}
