import { randomUUID } from 'node:crypto';

import {
  assertExecutionRegistration,
  executionRootPath,
  type ExecutionRootRecord,
  type ExecutionRootRegistration,
  type ExecutionRootState,
} from '../../src/domain/versions/ExecutionRoot.js';
import type { ExecutionRootStore } from '../../src/domain/versions/ExecutionRootService.js';

/**
 * The execution rows, in memory, with the state machine and none of the locks.
 *
 * Deliberately looser than `PostgresExecutionRootRepository`: what the real one
 * refuses under its locks is the database suite's subject, and this one exists
 * so a unit test can watch a real copy being made and used. The two rules it
 * does keep are the ones a caller can get wrong: a job owns one copy, and a
 * launched copy is retired only once its deployment has moved on.
 */
export class InMemoryExecutionRoots implements ExecutionRootStore {
  readonly records: ExecutionRootRecord[] = [];
  private made = 0;

  /**
   * The parent every copy sits under, and which instance each profile name is
   * on now, which is how a removed or recreated deployment is told from a live
   * one. A name with no answer has no profile row.
   */
  constructor(
    private readonly executionsParent: string,
    private readonly instanceOf: (profileName: string) => string | undefined,
  ) {}

  async listUnreleased(): Promise<ExecutionRootRecord[]> {
    return this.records.filter(record => record.state !== 'released').map(record => structuredClone(record));
  }

  async register(input: ExecutionRootRegistration): Promise<ExecutionRootRecord> {
    assertExecutionRegistration(input);
    if (this.records.some(record => record.jobReferenceId === input.jobReferenceId)) {
      throw new Error('The job already owns an execution root.');
    }
    this.made += 1;
    const record: ExecutionRootRecord = {
      ...structuredClone(input),
      project: input.profile.name,
      root: executionRootPath(this.executionsParent, input.executionId),
      state: 'registered',
      copyToken: null,
      referenceId: this.made,
      // One millisecond apart, so a test's copies order the way they were made.
      createdAt: new Date(Date.UTC(2026, 8, 11) + this.made),
    };
    this.records.push(record);
    return structuredClone(record);
  }

  async beginCopy(id: string): Promise<ExecutionRootRecord | null> {
    return this.change(id, ['registered'], 'copying', randomUUID());
  }

  async markReady(id: string, copyToken: string, digest: string): Promise<ExecutionRootRecord | null> {
    const record = this.find(id);
    if (!record || record.state !== 'copying') throw new Error('Execution is not owned by a preparing copy.');
    if (record.copyToken !== copyToken || record.source.artifactDigest !== digest) {
      throw new Error('Copy ownership or verified source digest changed.');
    }
    return this.change(id, ['copying'], 'ready', copyToken);
  }

  async claimLaunch(id: string): Promise<ExecutionRootRecord | null> {
    return this.change(id, ['ready'], 'launch-uncertain');
  }

  async claimUnstartedCleanup(id: string): Promise<ExecutionRootRecord | null> {
    return this.change(id, ['registered', 'ready'], 'deleting');
  }

  async claimInterruptedCopyCleanup(id: string): Promise<ExecutionRootRecord | null> {
    return this.change(id, ['copying'], 'deleting');
  }

  async claimRetiredCleanup(id: string): Promise<ExecutionRootRecord | null> {
    const record = this.find(id);
    if (!record || record.state !== 'launch-uncertain') return null;
    const replaced = this.records.some(other => other.profile.name === record.profile.name
      && other.state === 'launch-uncertain' && other.createdAt > record.createdAt);
    if (!replaced && this.instanceOf(record.profile.name) === record.profile.instanceId) return null;
    return this.change(id, ['launch-uncertain'], 'deleting');
  }

  async completeCleanup(id: string, removeOwnedRoot: (record: ExecutionRootRecord) => Promise<void>): Promise<ExecutionRootRecord> {
    const record = this.find(id);
    if (!record) throw new Error('Execution was not found.');
    if (record.state === 'released') return structuredClone(record);
    if (record.state !== 'deleting') throw new Error('Execution has not exclusively claimed unstarted cleanup.');
    await removeOwnedRoot(structuredClone(record));
    record.state = 'released';
    return structuredClone(record);
  }

  stateOf(id: string): ExecutionRootState | null {
    return this.find(id)?.state ?? null;
  }

  private find(id: string): ExecutionRootRecord | undefined {
    return this.records.find(record => record.executionId === id);
  }

  private change(id: string, from: ExecutionRootState[], to: ExecutionRootState, copyToken?: string): ExecutionRootRecord | null {
    const record = this.find(id);
    if (!record || !from.includes(record.state)) return null;
    record.state = to;
    if (copyToken !== undefined) record.copyToken = copyToken;
    return structuredClone(record);
  }
}
