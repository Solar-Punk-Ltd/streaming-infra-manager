import { TargetNotVerifiedError } from '../errors/index.js';
import type { DeployTargets } from './DeployTargets.js';
import { targetAlias } from './DeployTargets.js';
import type { DeployTargetRecord, DeployTargetRepository } from './DeployTargetRepository.js';

const PROBE_FAILED = 'The manager could not read a Docker daemon identity on this target. Check its connection and verify it again.';

export interface TargetIdentityProbe {
  daemonId(alias: string): Promise<string>;
}

export class VerifiedDeployTargets implements DeployTargets {
  constructor(
    private readonly repo: DeployTargetRepository,
    private readonly probe: TargetIdentityProbe,
  ) {}

  list(): Promise<DeployTargetRecord[]> {
    return this.repo.list();
  }

  async daemonIdFor(host: string | null): Promise<string> {
    const alias = targetAlias(host);
    const target = await this.repo.find(alias);
    if (target?.daemonId && target.verifiedAt) return target.daemonId;
    return this.verify(alias);
  }

  async verify(host: string | null): Promise<string> {
    const alias = targetAlias(host);
    let daemonId: string;
    try {
      daemonId = await this.probe.daemonId(alias);
      if (!daemonId.trim()) throw new Error('empty identity');
    } catch {
      // Subprocess errors can include remote diagnostics. Only this fixed explanation is stored.
      await this.repo.failed(alias, PROBE_FAILED);
      throw new TargetNotVerifiedError(alias, PROBE_FAILED);
    }
    const target = await this.repo.verified(alias, daemonId);
    if (!target.verifiedAt || !target.daemonId) {
      throw new TargetNotVerifiedError(alias, target.lastError ?? PROBE_FAILED);
    }
    return target.daemonId;
  }
}
