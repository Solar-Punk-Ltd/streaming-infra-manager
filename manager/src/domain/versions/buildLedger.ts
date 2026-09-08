import type { Profile, ProfileStatus } from '../../types/index.js';

import type { BuildReference } from './buildReferences.js';
import type { StackVersionRecord } from './StackVersionRepository.js';

/** The reference key of a legacy row's flat root, and of the bundled checkout, which are not builds. */
export const LEGACY_BUILD_ID = 'legacy';
export const BUNDLED_BUILD_ID = 'bundled';

/**
 * The build a deploy runs, captured when the deployment was claimed: the
 * version as it was read then, the build's identity and its root. A deploy
 * reads nothing about its version again after the claim, so it cannot
 * select one build and later read another version's contract.
 */
export interface BuildDescriptor {
  /** Null when the row the profile names is gone, which deploys the bundled checkout with a warning. */
  version: StackVersionRecord | null;
  buildId: string;
  root: string;
  /** The job reference the claim inserted, or null when there was no version row to reference. */
  referenceId: number | null;
}

/** One service's container, and the build it was seen to be started from. */
export interface Observation {
  service: string;
  buildId: string;
  /** The build's commit from its manifest, or null for a root that is not a build. */
  commit: string | null;
}

export interface ClaimedDeploy {
  profile: Profile;
  descriptor: BuildDescriptor;
}

/**
 * What a container mounts, asked of Docker: the directory the container's
 * compose project was started from, or null when there is no container.
 */
export interface MountObserver {
  mountedRootOf(profileName: string, service: string): Promise<string | null>;
}

/**
 * The ledger of which build each deployment runs on. The claim and the job
 * reference are one write, the observation after a deploy writes what the
 * containers actually mount, and a job reference resolves only by
 * observation, so a build stays until nothing may still mount it.
 */
export interface BuildLedger {
  /** Cancel only this job's reference when its caller knows no script was launched. Older jobs remain protected. */
  cancelUnstarted(profileName: string, referenceId: number): Promise<void>;
  /**
   * Moves the profile to DEPLOYING from one of `from` and records the job
   * reference in the same write. Null when the status claim fails, and then
   * nothing was written.
   */
  claim(
    profileName: string,
    from: readonly ProfileStatus[],
    version: StackVersionRecord | null,
    services: readonly string[],
  ): Promise<ClaimedDeploy | null>;
  /** The descriptor and the job reference for a row inserted DEPLOYING already. */
  describe(
    profileName: string,
    version: StackVersionRecord | null,
    services: readonly string[],
  ): Promise<BuildDescriptor>;
  /**
   * Asks Docker what each service mounts, writes one snapshot reference per
   * service observed, and resolves every job reference of the profile that
   * newer observations cover. Answers what was seen. Throws when Docker
   * cannot be asked, and then nothing was written.
   */
  observe(profileName: string, services: readonly string[]): Promise<Observation[]>;
  /** The same observation for every profile, at boot. */
  observeAll(): Promise<void>;
}

/**
 * What prune reads, and the lock it holds while it deletes: the version
 * row's update lock, so a claim that takes the row's share lock either
 * committed its reference before prune read, or waits and reads the row as
 * prune left it. Held for the deletion only, never for a build.
 */
export interface BuildReferenceReader {
  openReferences(versionId: number): Promise<BuildReference[]>;
  pendingShipmentBuildIds(versionId: number): Promise<string[]>;
  /** Runs `work` while the version row is locked for update. */
  lockVersion?<T>(versionId: number, work: () => Promise<T>): Promise<T>;
}
