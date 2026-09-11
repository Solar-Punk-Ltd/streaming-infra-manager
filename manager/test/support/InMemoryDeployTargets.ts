import type { DeployTargetRecord, DeployTargetRepository } from '../../src/domain/ports/DeployTargetRepository.js';
import { DAEMON_CHANGED } from '../../src/domain/ports/DeployTargetRepository.js';

export class InMemoryDeployTargets implements DeployTargetRepository {
  readonly rows = new Map<string, DeployTargetRecord>();

  async list(): Promise<DeployTargetRecord[]> {
    return [...this.rows.values()];
  }

  async find(alias: string): Promise<DeployTargetRecord | null> {
    return this.rows.get(alias) ?? null;
  }

  async verified(alias: string, daemonId: string): Promise<DeployTargetRecord> {
    const previous = this.rows.get(alias);
    const changed = previous?.daemonId && previous.daemonId !== daemonId;
    const row = {
      alias,
      daemonId: changed ? previous.daemonId : daemonId,
      verifiedAt: changed ? null : new Date(),
      lastError: changed ? DAEMON_CHANGED : null,
    };
    this.rows.set(alias, row);
    return row;
  }

  async failed(alias: string, reason: string): Promise<void> {
    this.rows.set(alias, {
      alias,
      daemonId: this.rows.get(alias)?.daemonId ?? null,
      verifiedAt: null,
      lastError: reason,
    });
  }
}
