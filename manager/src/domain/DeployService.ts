import {
  SCRIPT_CLEAN,
  SCRIPT_DEPLOY,
  SCRIPT_HEALTH,
  SCRIPT_STOP,
  SUBMODULE,
} from '../utils/repo.js';
import {
  ActionInput,
  ActionKind,
  KIND_DEFAULT_SERVICES,
  Profile,
} from '../types.js';

import { ProfileService } from './ProfileService.js';
import { RunHandle, ScriptRunner } from './ScriptRunner.js';

/**
 * Translates a (profile, action, input) triple into the right `bash deploy.sh
 * --profile=X --portPrefix=N ...` invocation and hands a RunHandle back to the
 * caller. The caller (route handler) is responsible for binding the emitter
 * to its transport (SSE, in our case).
 */
export class DeployService {
  constructor(
    private readonly profileService: ProfileService,
    private readonly runner: ScriptRunner,
  ) {}

  async run(profileName: string, action: ActionKind, input: ActionInput = {}): Promise<RunHandle> {
    const profile = await this.profileService.getByName(profileName);
    const script = this.scriptForAction(action);
    const args = this.buildArgs(profile, action, input);
    return this.runner.run(script, args, { cwd: SUBMODULE });
  }

  private scriptForAction(action: ActionKind): string {
    switch (action) {
      case 'deploy':
        return SCRIPT_DEPLOY;
      case 'stop':
        return SCRIPT_STOP;
      case 'clean':
        return SCRIPT_CLEAN;
      case 'health':
        return SCRIPT_HEALTH;
    }
  }

  private buildArgs(profile: Profile, action: ActionKind, input: ActionInput): string[] {
    const args: string[] = [
      `--profile=${profile.name}`,
      `--portPrefix=${profile.port_prefix}`,
    ];

    if (action === 'clean') {
      // Always non-interactive when invoked via HTTP.
      args.push('--yes');
      if (input.volumes) args.push('--volumes');
      if (input.all) args.push('--all');
    }

    const services =
      input.services && input.services.length > 0
        ? input.services
        : [...(KIND_DEFAULT_SERVICES[profile.kind] ?? [])];

    args.push(...services);
    return args;
  }
}
