import {
  hasUsableStamp,
  servicesNeedStamp,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

import { Profile } from '../types/index.js';

// The gating rules live in @streaming-infra-manager/common so the frontend
// derives the exact same "needs a stamp / has a stamp" answers.
export {
  defaultServicesFor,
  hasUsableStamp,
  isPendingStamp,
  servicesNeedStamp,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

export interface DeploySplit {
  /** Services to hand to deploy.sh now. */
  deploy: string[];
  /** Services deferred until a usable stamp exists. */
  heldBack: string[];
}

/**
 * Drop the stream-uploader from the deploy set when there is no usable stamp,
 * so the submodule's interactive STAMP guard never fires (it would EOF-abort
 * under the manager's stdin-less ScriptRunner).
 */
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
