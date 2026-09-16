import {
  type AttemptOutcome,
  type DeployAttempt,
  whyAdmissionIsRefused,
} from '../../src/domain/deployAttempts.js';
import {
  containerIdsByService,
  type DaemonObserver,
  type DaemonSnapshot,
  type DeployAttemptRepository,
  type NewDeployAttempt,
  type AttemptSnapshotToken,
  type ObservedContainer,
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
    if (attempt.snapshotToken) {
      const current = this.snapshotTokenFor(attempt.daemonId, attempt.project);
      const expected = attempt.snapshotToken;
      if (expected.daemonId !== current.daemonId || expected.project !== current.project ||
          expected.latestAttemptId !== current.latestAttemptId) {
        throw new DeployAttemptRefusedError(attempt.project, 'Deploy attempt history changed while the container snapshot was read.');
      }
    }
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

  async captureSnapshotToken(daemonId: string, project: string): Promise<AttemptSnapshotToken> {
    return this.snapshotTokenFor(daemonId, project);
  }

  private snapshotTokenFor(daemonId: string, project: string): AttemptSnapshotToken {
    const history = this.rows.filter(row => row.daemonId === daemonId && row.project === project);
    if (history.some(row => row.state !== 'released')) {
      throw new DeployAttemptRefusedError(project, 'An unresolved deploy attempt prevents a container snapshot.');
    }
    const latest = history.reduce<number | null>((id, row) => id === null || row.id > id ? row.id : id, null);
    return { daemonId, project, latestAttemptId: latest === null ? null : String(latest) };
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

  readonly containers = new Map<string, Map<string, ObservedContainer[]>>();


  async daemonId(_target?: string): Promise<string> {
    return this.id;
  }

  async snapshot(project: string, target = 'localhost'): Promise<DaemonSnapshot> {
    return { daemonId: await this.daemonId(target), containers: await this.observe(project, target) };
  }

  async containerIdsOf(project: string, target?: string): Promise<Map<string, string[]>> {
    return containerIdsByService(await this.observe(project, target));
  }

  /**
   * What Docker has for the project, which both readers above answer from. A
   * test whose containers depend on the target replaces this rather than either
   * of them, so the two cannot disagree.
   */
  async observe(project: string, _target?: string): Promise<Map<string, ObservedContainer[]>> {
    const byService = this.containers.get(project) ?? new Map<string, ObservedContainer[]>();
    return new Map([...byService].map(([service, observed]) => [service, [...observed]]));
  }

  /** Containers a test did not give a state of its own are up, which is the ordinary case. */
  set(project: string, service: string, ids: string[], state = 'running'): void {
    const byService = this.containers.get(project) ?? new Map<string, ObservedContainer[]>();
    byService.set(service, ids.map((id) => ({ id, state })));
    this.containers.set(project, byService);
  }
}
