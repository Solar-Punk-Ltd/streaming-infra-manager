import { ActionInput, ActionKind } from '../types/index.js';

import { DeploymentOrchestrator } from './DeploymentOrchestrator.js';
import { ProfileService } from './ProfileService.js';
import { RunHandle } from './ScriptRunner.js';
import { StampService } from './StampService.js';

export class DeployService {
  constructor(
    private readonly profileService: ProfileService,
    private readonly orchestrator: DeploymentOrchestrator,
    private readonly stampService: StampService,
  ) {}

  async run(
    profileName: string,
    action: ActionKind,
    input: ActionInput = {},
  ): Promise<RunHandle> {
    const profile = await this.profileService.getByName(profileName);

    switch (action) {
      case 'deploy':
        return this.orchestrator.startDeploy(profile, input.services);
      case 'deploy-uploader':
        // An expired/unknown stamp would deploy an uploader that can only
        // fail uploads — reject early when the bee node can tell us.
        if (profile.stamp_id) {
          await this.stampService.assertStampUsable(
            profile.name,
            profile.stamp_id,
          );
        }
        return this.orchestrator.startDeployUploader(profile);
      case 'stop':
        return this.orchestrator.startStop(profile, input.services);
      case 'clean':
        return this.orchestrator.startRemove(profile, { all: input.all });
      case 'health':
        return this.orchestrator.startHealth(profile);
    }
  }
}
