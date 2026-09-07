import type { StackVersionRecord } from '../../src/domain/versions/StackVersionRepository.js';
import {
  type BuildDescriptor,
  type BuildLedger,
  BUNDLED_BUILD_ID,
  type ClaimedDeploy,
  LEGACY_BUILD_ID,
} from '../../src/domain/versions/buildLedger.js';
import {
  type BuildReference,
  buildIdOfRoot,
  coveredJobReferences,
} from '../../src/domain/versions/buildReferences.js';
import { stackRootOf } from '../../src/domain/versions/stackPaths.js';
import type { ProfileStatus } from '../../src/types/index.js';

import type { InMemoryProfiles } from './profileFixtures.js';

/**
 * The build ledger over a Map, with what Docker would say scripted: `mounted`
 * holds the root each profile's service mounts, and a profile in
 * `observeFailures` is one Docker cannot be asked about.
 */
export class InMemoryBuildLedger implements BuildLedger {
  readonly references: BuildReference[] = [];

  /** `<profile>/<service>` to the root the container was started from. */
  readonly mounted = new Map<string, string>();

  readonly observeFailures = new Set<string>();

  readonly observed: string[] = [];

  private nextId = 1;

  private clock = 0;

  constructor(
    private readonly profiles: InMemoryProfiles,
    private readonly versionsRoot: string,
  ) {}

  async claim(
    profileName: string,
    from: readonly ProfileStatus[],
    version: StackVersionRecord | null,
    services: readonly string[],
  ): Promise<ClaimedDeploy | null> {
    const profile = await this.profiles.transitionStatus(profileName, 'DEPLOYING', from);
    if (!profile) return null;
    return { profile, descriptor: await this.describe(profileName, version, services) };
  }

  async describe(
    profileName: string,
    version: StackVersionRecord | null,
    services: readonly string[],
  ): Promise<BuildDescriptor> {
    const root = stackRootOf(version ?? { rootPath: null });
    const buildId = version === null ? BUNDLED_BUILD_ID : buildIdOfRoot(this.versionsRoot, root);
    if (version === null) return { version, buildId, root, referenceId: null };
    const reference: BuildReference = {
      id: this.nextId++,
      versionId: version.id,
      buildId,
      holderKind: 'job',
      holderId: profileName,
      services: [...services],
      createdAt: new Date(++this.clock),
      resolvedAt: null,
    };
    this.references.push(reference);
    return { version, buildId, root, referenceId: reference.id };
  }

  async observe(profileName: string, services: readonly string[]): Promise<void> {
    if (this.observeFailures.has(profileName)) throw new Error('the daemon did not answer');
    this.observed.push(profileName);
    const versionOf = (root: string): number | null =>
      this.references.find((reference) => reference.holderId === profileName && reference.holderKind === 'job')?.versionId ?? null;
    for (const service of services) {
      const root = this.mounted.get(`${profileName}/${service}`);
      if (!root) continue;
      const versionId = versionOf(root);
      if (versionId === null) continue;
      this.references.push({
        id: this.nextId++,
        versionId,
        buildId: buildIdOfRoot(this.versionsRoot, root),
        holderKind: 'snapshot',
        holderId: `${profileName}/${service}`,
        services: [service],
        createdAt: new Date(++this.clock),
        resolvedAt: null,
      });
    }
    const covered = new Set(coveredJobReferences(this.references.filter((r) => r.holderKind !== 'job' || r.holderId === profileName)));
    for (const reference of this.references) {
      if (covered.has(reference.id)) reference.resolvedAt = new Date(++this.clock);
    }
  }

  async observeAll(): Promise<void> {
    for (const profile of await this.profiles.list()) {
      const services = [...new Set(this.references.filter((r) => r.holderId === profile.name && r.holderKind === 'job').flatMap((r) => [...r.services]))];
      await this.observe(profile.name, services);
    }
  }

  openJobReferences(profileName: string): BuildReference[] {
    return this.references.filter((r) => r.holderKind === 'job' && r.holderId === profileName && r.resolvedAt === null);
  }

  /** What the legacy and bundled keys stand for, for a test that asserts them. */
  static readonly LEGACY = LEGACY_BUILD_ID;
}
