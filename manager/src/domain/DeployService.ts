import { ActionInput, ActionKind } from '../types/index.js';

import { DeploymentOrchestrator } from './DeploymentOrchestrator.js';
import { ProfileService } from './ProfileService.js';
import { RunHandle } from './ScriptRunner.js';

export class DeployService {
  constructor(
    private readonly profileService: ProfileService,
    private readonly orchestrator: DeploymentOrchestrator,
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
      case 'stop':
        return this.orchestrator.startStop(profile, input.services);
      case 'clean':
        return this.orchestrator.startRemove(profile, {
          volumes: input.volumes,
          all: input.all,
        });
      case 'health':
        return this.orchestrator.startHealth(profile);
    }
  }
}
