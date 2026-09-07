import type { Profile, ProfileStatus } from '../../types/index.js';

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
   * newer observations cover. Throws when Docker cannot be asked, and then
   * nothing was written.
   */
  observe(profileName: string, services: readonly string[]): Promise<void>;
  /** The same observation for every profile, at boot. */
  observeAll(): Promise<void>;
}
