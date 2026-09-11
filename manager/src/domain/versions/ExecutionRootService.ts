import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

import { getErrorMessage } from '@streaming-infra-manager/common';

import { Logger } from '../Logger.js';

import type { ExecutionRootRecord, ExecutionRootRegistration } from './ExecutionRoot.js';
import { readBuildManifest } from './buildManifest.js';
import { currentExecutionOf, executionsToRetire } from './executionRetention.js';
import { copyExecutionRoot, removeExecutionRoot } from './executionRootFiles.js';
import { inventoryOwnedTree, ownedTreeDigest } from './ownedTreeInventory.js';

const logger = Logger.getInstance();

/** What `PostgresExecutionRootRepository` answers, named here so the service can be tested without one. */
export interface ExecutionRootStore {
  listUnreleased(): Promise<ExecutionRootRecord[]>;
  register(input: ExecutionRootRegistration): Promise<ExecutionRootRecord>;
  beginCopy(id: string): Promise<ExecutionRootRecord | null>;
  markReady(id: string, copyToken: string, digest: string): Promise<ExecutionRootRecord | null>;
  claimLaunch(id: string): Promise<ExecutionRootRecord | null>;
  claimUnstartedCleanup(id: string): Promise<ExecutionRootRecord | null>;
  claimInterruptedCopyCleanup(id: string): Promise<ExecutionRootRecord | null>;
  claimRetiredCleanup(id: string): Promise<ExecutionRootRecord | null>;
  completeCleanup(id: string, removeOwnedRoot: (record: ExecutionRootRecord) => Promise<void>): Promise<ExecutionRootRecord>;
}

export interface ExecutionSourceBuild {
  versionId: number;
  buildId: string;
  root: string;
  /** A version that does not keep immutable builds cannot have a private copy. */
  layout: string;
}

export interface ExecutionPreparation {
  profile: { name: string; instanceId: string; intentRevision: number; status: ExecutionRootRegistration['profile']['status'] };
  build: ExecutionSourceBuild;
  jobReferenceId: number;
  target: { alias: string; daemonId: string };
  services: readonly string[];
}

export interface PreparedExecution {
  executionId: string;
  root: string;
}

/** What a deployment's copies cost the boot, so the line reads as one sentence. */
export interface ReclaimedExecutions {
  removed: string[];
  kept: string[];
}

/**
 * What the deploy machinery asks of an execution copy.
 *
 * Kept as an interface so an orchestrator wired without one runs from the
 * build directory itself, which is what every deployment did before copies
 * existed, and so the orchestrator depends on the questions rather than on
 * the repository that answers them.
 */
export interface ExecutionRoots {
  /** Null when this version keeps no immutable builds, which leaves the build as the root. */
  prepare(input: ExecutionPreparation): Promise<PreparedExecution | null>;
  claimLaunch(executionId: string): Promise<void>;
  retireUnstarted(executionId: string): Promise<void>;
  retireSuperseded(profileName: string, input: { keep: number }): Promise<void>;
  currentRootFor(profile: { name: string; instanceId: string }): Promise<string | null>;
}

/**
 * The private copy of a build that one deployment runs its scripts from.
 *
 * A deploy used to run the stack's scripts inside the version's build
 * directory and write its own env files there, so the artifact stopped being
 * the bytes it was published as, and two deployments of one build shared one
 * mutable tree. Each deploy now copies the build into a directory of its own,
 * registered against the job reference it already holds, and runs there.
 *
 * Retention is Levi's decision D11: a deployment keeps the copy it runs from
 * and the one before it, so a deploy that fails leaves the tree that last
 * worked in place, and a deploy that succeeds takes it.
 */
export class ExecutionRootService implements ExecutionRoots {
  constructor(
    private readonly roots: ExecutionRootStore,
    private readonly executionsParent: string,
  ) {}

  /**
   * Copies the build this deploy was admitted on, or null when the version
   * keeps no immutable builds and the deploy runs from its flat tree as it
   * always did.
   *
   * Everything the copy needs is read here rather than from the version row:
   * the commit comes from the build's own manifest, and the digest from the
   * tree as it stands, so the copy is verified against what is actually there.
   */
  async prepare(input: ExecutionPreparation): Promise<PreparedExecution | null> {
    if (input.build.layout !== 'builds') return null;
    const manifest = readBuildManifest(input.build.root).manifest;
    if (!manifest) return null;
    const registration: ExecutionRootRegistration = {
      executionId: randomUUID(),
      source: {
        versionId: input.build.versionId,
        buildId: input.build.buildId,
        commit: manifest.commit,
        root: input.build.root,
        artifactDigest: ownedTreeDigest(await inventoryOwnedTree(input.build.root)),
      },
      profile: { ...input.profile },
      jobReferenceId: input.jobReferenceId,
      target: { ...input.target },
      action: 'deploy',
      services: [...input.services],
    };
    await mkdir(this.executionsParent, { recursive: true, mode: 0o700 });
    const registered = await this.roots.register(registration);
    try {
      const copying = await this.roots.beginCopy(registered.executionId);
      if (!copying?.copyToken) throw new Error('The execution copy could not take its exclusive token.');
      const copied = await copyExecutionRoot(copying, this.executionsParent);
      await this.roots.markReady(copying.executionId, copying.copyToken, copied.artifactDigest);
      logger.info(`[Executions] ${input.profile.name}: copied build ${input.build.buildId} to ${registered.executionId}`);
      return { executionId: registered.executionId, root: copied.root };
    } catch (err) {
      await this.retireUnstarted(registered.executionId);
      throw err;
    }
  }

  /**
   * Records that a process may have run from this copy, before one can have.
   *
   * There is no way back from here except supersession, which is the point: a
   * copy a script may have started under is never deleted on a caller's word.
   */
  async claimLaunch(executionId: string): Promise<void> {
    if (!(await this.roots.claimLaunch(executionId))) {
      throw new Error(`Execution ${executionId} is not a prepared copy ready to launch. Nothing was started.`);
    }
  }

  /** A copy whose deploy failed before anything could be spawned. */
  async retireUnstarted(executionId: string): Promise<void> {
    await this.remove(executionId, () => this.roots.claimUnstartedCleanup(executionId));
  }

  /**
   * The copies this deployment has moved on from. `keep` is 2 while a deploy is
   * in flight, 1 once one has succeeded, and 0 once the deployment is gone.
   *
   * Never fails its caller: a deploy that came up is not undone because a tree
   * from an older one could not be deleted, and the copy keeps its hold on the
   * build until a later round manages it.
   */
  async retireSuperseded(profileName: string, input: { keep: number }): Promise<void> {
    try {
      for (const record of executionsToRetire(await this.roots.listUnreleased(), { profileName, ...input })) {
        await this.remove(record.executionId, () => this.roots.claimRetiredCleanup(record.executionId));
      }
    } catch (err) {
      logger.warn(`[Executions] ${profileName}: an older copy was not retired: ${getErrorMessage(err)}. It keeps its hold on its build.`);
    }
  }

  /** The copy this deployment runs its scripts from, or null when it runs from a build. */
  async currentRootFor(profile: { name: string; instanceId: string }): Promise<string | null> {
    return currentExecutionOf(await this.roots.listUnreleased(), profile)?.root ?? null;
  }

  /**
   * What a gone manager left. Run at boot, before anything deploys, and safe
   * only there: nothing can have run from a copy that never reached ready, and
   * no copy is being written while the manager is starting.
   *
   * A launched copy is left exactly as it is. Only its deployment moving on
   * retires one.
   */
  async reclaimInterrupted(): Promise<ReclaimedExecutions> {
    const outcome: ReclaimedExecutions = { removed: [], kept: [] };
    for (const record of await this.roots.listUnreleased()) {
      const claim = {
        registered: () => this.roots.claimUnstartedCleanup(record.executionId),
        ready: () => this.roots.claimUnstartedCleanup(record.executionId),
        copying: () => this.roots.claimInterruptedCopyCleanup(record.executionId),
        deleting: async () => record,
      }[record.state as 'registered' | 'ready' | 'copying' | 'deleting'];
      if (!claim) {
        outcome.kept.push(record.executionId);
        continue;
      }
      try {
        await this.remove(record.executionId, claim);
        outcome.removed.push(record.executionId);
      } catch (err) {
        logger.warn(`[Executions] copy ${record.executionId} was not reclaimed: ${getErrorMessage(err)}. It keeps its hold on its build.`);
        outcome.kept.push(record.executionId);
      }
    }
    if (outcome.removed.length > 0 || outcome.kept.length > 0) {
      logger.info(`[Executions] copies at boot: removed ${outcome.removed.join(', ') || 'none'}, kept ${outcome.kept.join(', ') || 'none'}`);
    }
    return outcome;
  }

  private async remove(executionId: string, claim: () => Promise<ExecutionRootRecord | null>): Promise<void> {
    if (!(await claim())) return;
    await this.roots.completeCleanup(executionId, record => removeExecutionRoot(record, this.executionsParent));
  }
}
