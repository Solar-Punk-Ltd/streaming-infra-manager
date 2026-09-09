import type {
  StackContract,
  StackVersionStatus,
} from '@streaming-infra-manager/common';

/** One row of `stack_versions`, as the domain reads it. */
/**
 * Where a version deploys from. A legacy row deploys from its flat root, the
 * checkout the build script used to move in place. A builds row deploys from
 * its current build, one immutable directory under the builds root, and
 * never from the flat root, which keeps only the host-owned inputs.
 */
export type StackVersionLayout = 'legacy' | 'builds';

export interface StackVersionRecord {
  id: number;
  name: string;
  gitRef: string;
  commitSha: string | null;
  status: StackVersionStatus;
  /** Null for the bundled version, whose root only the manager knows. */
  rootPath: string | null;
  layout: StackVersionLayout;
  /** The current build of a builds row: the commit, or `<commit>-r<n>`. */
  buildId: string | null;
  /** The build the current one replaced, kept for recovery until nothing references it. */
  previousBuildId: string | null;
  contract: StackContract | null;
  isDefault: boolean;
  tested: boolean;
  builtAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

/** A version and how many deployments run it. */
export interface StackVersionUsage extends StackVersionRecord {
  deployments: number;
}

export interface NewStackVersion {
  name: string;
  gitRef: string;
  /** Null only for the bundled row, which the migration inserts. */
  rootPath: string;
}

export interface BuildOutcome {
  commitSha: string | null;
  contract: StackContract;
}

/** What one publication writes: the build that is current from now on. */
export interface PublishOutcome {
  buildId: string;
  commitSha: string;
  contract: StackContract;
  /**
   * The row's root from this publication on, for a row that had none: the
   * bundled version gets its config root when its first shipped build is
   * published, and deploys from its builds from then on.
   */
  rootPath?: string;
}

/**
 * The versions of the streaming stack this manager holds.
 *
 * Which version is the default is a property of the table rather than of any
 * row, so `setDefault` moves it in one transaction: the partial unique index in
 * migration 010 refuses two defaults, and clearing before setting is the only
 * order that never trips it.
 */
export interface StackVersionRepository {
  list(): Promise<StackVersionUsage[]>;
  findById(id: number): Promise<StackVersionRecord | null>;
  findByName(name: string): Promise<StackVersionRecord | null>;
  findDefault(): Promise<StackVersionRecord | null>;
  insert(version: NewStackVersion): Promise<StackVersionRecord>;
  /** Back to `building`, for an update of a version already on disk. */
  markBuilding(id: number): Promise<StackVersionRecord | null>;
  /**
   * Ready, on the commit and contract the build landed on. `tested` survives
   * only when that is the commit the row already carried: the approval is a
   * person's word about one commit, not about the row.
   */
  markBuilt(id: number, outcome: BuildOutcome): Promise<StackVersionRecord | null>;
  /**
   * One row update, under the row's own lock: ready, layout builds, the new
   * build current and the one it replaced kept as previous. `tested` survives
   * only when the build id did not change, because the approval keys on the
   * build.
   */
  publish(id: number, outcome: PublishOutcome): Promise<StackVersionRecord | null>;
  /** A build that failed for a version that still has a usable build: ready as before, with the reason. */
  markUpdateFailed(id: number, lastError: string): Promise<StackVersionRecord | null>;
  markFailed(id: number, lastError: string): Promise<StackVersionRecord | null>;
  /**
   * Every row left in `building` fails with `lastError`. A build only ever runs
   * inside one manager process, so at boot a building row is one whose process
   * is gone and nothing will ever finish it.
   */
  failInterruptedBuilds(lastError: string): Promise<StackVersionRecord[]>;
  setCommitSha(id: number, commitSha: string | null): Promise<void>;
  /** The contract alone, for the bundled version read at every boot. */
  setContract(id: number, contract: StackContract): Promise<void>;
  setDefault(id: number): Promise<void>;
  setTested(id: number, tested: boolean): Promise<StackVersionRecord | null>;
  /** All ownership guards and file cleanup share the version row lock. Cleanup failure retains the row. */
  removeGuarded(expected: StackVersionRecord, removeOwnedFiles: (locked: StackVersionRecord) => Promise<void>): Promise<boolean>;
  /** The deployments running this version, by name, for a refusal that says so. */
  deploymentNames(id: number): Promise<string[]>;
}
