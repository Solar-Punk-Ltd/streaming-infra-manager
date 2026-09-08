import {
  type AttemptOutcome,
  type DeployAttempt,
  whyAdmissionIsRefused,
} from '../../src/domain/deployAttempts.js';
import type {
  DaemonObserver,
  DaemonSnapshot,
  DeployAttemptRepository,
  NewDeployAttempt,
} from '../../src/domain/DeployAttemptRepository.js';
import { DeployAttemptRefusedError } from '../../src/domain/errors/index.js';

/** The attempts table over an array, with the admission rules the SQL applies under its lock. */
export class InMemoryDeployAttempts implements DeployAttemptRepository {
  readonly rows: DeployAttempt[] = [];

  /**
   * When set, the list the orchestrator's pre-check reads is empty while
   * `open` still applies the rules: the moment between two deploys' checks
   * and their guards, when both passed the check and one loses the guard.
   */
  precheckBlind = false;

  private nextId = 1;

  async open(attempt: NewDeployAttempt): Promise<DeployAttempt> {
    const refusal = whyAdmissionIsRefused(attempt, this.rows);
    if (refusal) throw new DeployAttemptRefusedError(attempt.project, refusal);
    const row: DeployAttempt = {
      id: this.nextId++,
      ...attempt,
      target: attempt.target ?? null,
      services: [...attempt.services],
      preJobContainerIds: [...attempt.preJobContainerIds],
      state: 'open',
      reason: null,
      startedAt: new Date(),
      resolvedAt: null,
      releasedBy: null,
    };
    this.rows.push(row);
    return row;
  }

  async findByJob(jobId: string): Promise<DeployAttempt | null> {
    return this.rows.find((row) => row.jobId === jobId) ?? null;
  }

  async listUnresolved(daemonId?: string): Promise<DeployAttempt[]> {
    if (this.precheckBlind) return [];
    return this.rows.filter((row) => (daemonId === undefined || row.daemonId === daemonId) && row.state !== 'released');
  }

  async releaseProject(daemonId: string, project: string, by: string): Promise<DeployAttempt[]> {
    const released = this.rows.filter(
      (row) => row.daemonId === daemonId && row.project === project && row.state !== 'released',
    );
    for (const row of released) {
      Object.assign(row, { state: 'released', releasedBy: by, resolvedAt: new Date() });
    }
    return released;
  }

  async listBlocked(): Promise<DeployAttempt[]> {
    return this.rows.filter((row) => row.state === 'blocked');
  }

  async resolve(id: number, outcome: AttemptOutcome): Promise<DeployAttempt | null> {
    const row = this.rows.find((r) => r.id === id);
    if (!row || row.state !== 'open') return null;
    Object.assign(row, { state: outcome.state, reason: outcome.reason, resolvedAt: new Date() });
    return row;
  }

  async release(id: number, by: string): Promise<DeployAttempt | null> {
    const row = this.rows.find((r) => r.id === id);
    if (!row || row.state === 'released') return null;
    Object.assign(row, { state: 'released', releasedBy: by, resolvedAt: new Date() });
    return row;
  }
}

/**
 * Docker as a test scripts it: one daemon id, and the containers of each
 * project by service. With `autoRecreate` on, the harness gives every known
 * service of a project a new container when its deploy script finishes,
 * which is what compose does, so a test that is not about the guard sees
 * its attempts released. A test about the guard turns it off.
 */
export class FakeDaemon implements DaemonObserver {
  id = 'daemon-1';

  autoRecreate = true;

  readonly containers = new Map<string, Map<string, string[]>>();


  async daemonId(_target?: string): Promise<string> {
    return this.id;
  }

  async snapshot(project: string, target = 'localhost'): Promise<DaemonSnapshot> {
    return { daemonId: await this.daemonId(target), containers: await this.containerIdsOf(project, target) };
  }

  async containerIdsOf(project: string, _target?: string): Promise<Map<string, string[]>> {
    return new Map([...(this.containers.get(project) ?? new Map())].map(([service, ids]) => [service, [...ids]]));
  }

  set(project: string, service: string, ids: string[]): void {
    const byService = this.containers.get(project) ?? new Map<string, string[]>();
    byService.set(service, ids);
    this.containers.set(project, byService);
  }
}
