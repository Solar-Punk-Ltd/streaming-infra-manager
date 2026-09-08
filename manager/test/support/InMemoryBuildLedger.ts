import type {
  StackVersionRecord,
  StackVersionRepository,
} from '../../src/domain/versions/StackVersionRepository.js';
import {
  type BuildDescriptor,
  type BuildLedger,
  type BuildReferenceReader,
  BUNDLED_BUILD_ID,
  type ClaimedDeploy,
  LEGACY_BUILD_ID,
  type Observation,
} from '../../src/domain/versions/buildLedger.js';
import {
  type BuildReference,
  buildIdOfRoot,
  commitOfRoot,
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
export class InMemoryBuildLedger implements BuildLedger, BuildReferenceReader {
  readonly references: BuildReference[] = [];

  /** `<profile>/<service>` to the root the container was started from. */
  readonly mounted = new Map<string, string>();

  readonly observeFailures = new Set<string>();

  readonly observed: string[] = [];

  private nextId = 1;

  private clock = 0;

  constructor(
    private readonly profiles: InMemoryProfiles,
    private readonly versions: Pick<StackVersionRepository, 'findByName'>,
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

  async observe(profileName: string, services: readonly string[]): Promise<Observation[]> {
    if (this.observeFailures.has(profileName)) throw new Error('the daemon did not answer');
    this.observed.push(profileName);
    const observations: Observation[] = [];
    for (const service of services) {
      const root = this.mounted.get(`${profileName}/${service}`);
      if (!root) continue;
      observations.push({ service, buildId: buildIdOfRoot(this.versionsRoot, root), commit: commitOfRoot(root) });
      const versionId = await this.versionOfRoot(root);
      if (versionId === null) continue;
      for (const older of this.references) {
        if (older.holderKind === 'snapshot' && older.holderId === `${profileName}/${service}` && older.resolvedAt === null) {
          older.resolvedAt = new Date(++this.clock);
        }
      }
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
    return observations;
  }

  async observeAll(): Promise<void> {
    for (const profile of await this.profiles.list()) {
      const services = [...new Set(this.references.filter((r) => r.holderId === profile.name && r.holderKind === 'job').flatMap((r) => [...r.services]))];
      await this.observe(profile.name, services);
    }
  }

  async openReferences(versionId: number): Promise<BuildReference[]> {
    return this.references.filter((r) => r.versionId === versionId && r.resolvedAt === null);
  }

  openJobReferences(profileName: string): BuildReference[] {
    return this.references.filter((r) => r.holderKind === 'job' && r.holderId === profileName && r.resolvedAt === null);
  }

  /** What the legacy and bundled keys stand for, for a test that asserts them. */
  static readonly LEGACY = LEGACY_BUILD_ID;

  /**
   * The version a root belongs to, from the path segment under the versions
   * root, the way the real ledger reads it: `<name>`, `<name>.builds` and
   * `<name>.repo` all belong to `<name>`, and a root elsewhere to no version.
   */
  private async versionOfRoot(root: string): Promise<number | null> {
    if (!root.startsWith(`${this.versionsRoot}/`)) return null;
    const first = root.slice(this.versionsRoot.length + 1).split('/')[0] ?? '';
    const name = first.replace(/\.(builds|repo)$/, '');
    return (await this.versions.findByName(name))?.id ?? null;
  }
}
