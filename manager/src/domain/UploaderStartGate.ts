import { Profile } from '../types/index.js';

import { ChequebookService } from './ChequebookService.js';
import { UploaderGate } from './DeploymentOrchestrator.js';
import { StampService } from './StampService.js';

type StartCheck = (profile: Profile) => Promise<void>;

/**
 * What has to be true before a stream-uploader container is (re)created.
 *
 * The checks used to sit on the "deploy uploader" route alone, so the Retry
 * button, a settings change and a plain API deploy all recreated the uploader
 * unchecked. They belong to starting an uploader, not to one button, so the
 * orchestrator asks this on every route that starts one, and only for a
 * deployment whose own Bee node can be asked.
 *
 * The batch first, the chequebook second: a batch the node does not hold is
 * the cheaper question, and an uploader that fails it never needs the other.
 */
export class UploaderStartGate implements UploaderGate {
  private readonly checks: readonly StartCheck[];

  constructor(
    private readonly stamps: StampService,
    private readonly chequebook: ChequebookService,
  ) {
    this.checks = [
      (profile) => this.assertStampUsable(profile),
      (profile) => this.chequebook.assertFunded(profile.name),
    ];
  }

  async assertCanStart(profile: Profile): Promise<void> {
    for (const check of this.checks) {
      await check(profile);
    }
  }

  // An expired or unknown batch would start an uploader that can only fail its
  // uploads. The node can say so before anything is deployed.
  private async assertStampUsable(profile: Profile): Promise<void> {
    if (!profile.stamp_id) return;
    await this.stamps.assertStampUsable(profile.name, profile.stamp_id);
  }
}
