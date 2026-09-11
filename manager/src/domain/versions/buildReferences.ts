import { readBuildManifest } from './buildManifest.js';

/**
 * What keeps a build directory alive.
 *
 * A deploy claim inserts a `job` reference for the build it will run,
 * naming the services it touches. The success hook writes one `snapshot`
 * reference per service from what the containers actually mount. An
 * `operation` reference is a config file rollout's hold on the build its
 * recreate ran on. A job reference resolves only when snapshots newer than
 * it cover every service it named, so failure, a failed snapshot and a crash
 * leave it unresolved and the build stays. A later claim adds its own
 * reference and never touches an older one.
 */
export type BuildReferenceHolder = 'job' | 'snapshot' | 'operation' | 'execution';

export interface BuildReference {
  id: number;
  versionId: number;
  buildId: string;
  holderKind: BuildReferenceHolder;
  /** The profile for a job, `<profile>/<service>` for a snapshot, the operation id for an operation. */
  holderId: string;
  /** The services a job touches, or the one service a snapshot describes. */
  services: readonly string[];
  createdAt: Date;
  resolvedAt: Date | null;
}

/**
 * The reference key of a root: the build id under `<name>.builds`, `legacy`
 * for a version's flat root, `bundled` for anything else, which is the
 * bundled checkout.
 */
export function buildIdOfRoot(versionsRoot: string, root: string): string {
  const relative = root.startsWith(`${versionsRoot}/`) ? root.slice(versionsRoot.length + 1) : null;
  if (relative === null) return 'bundled';
  const [first, second] = relative.split('/');
  if (first?.endsWith('.builds') && second) return second;
  return 'legacy';
}

/** The commit a root was built from, off its manifest, or null for a root that is not a build. */
export function commitOfRoot(root: string): string | null {
  return readBuildManifest(root).manifest?.commit ?? null;
}

export interface NewBuildReference {
  versionId: number;
  buildId: string;
  holderKind: BuildReferenceHolder;
  holderId: string;
  services: readonly string[];
}

/** The profile a reference concerns: the job's holder, or the part of a snapshot's holder before the service. */
function profileOf(reference: BuildReference): string {
  return reference.holderKind === 'snapshot'
    ? reference.holderId.slice(0, reference.holderId.lastIndexOf('/'))
    : reference.holderId;
}

/**
 * The ids of the open job references every one of whose services has been
 * observed since the job, by a snapshot reference of the same profile that
 * is newer than it, whatever build the observation found.
 */
export function coveredJobReferences(references: readonly BuildReference[]): number[] {
  const snapshots = references.filter((reference) => reference.holderKind === 'snapshot');
  return references
    .filter((reference) => reference.holderKind === 'job' && reference.resolvedAt === null)
    .filter((job) =>
      job.services.every((service) =>
        snapshots.some(
          (snapshot) =>
            profileOf(snapshot) === job.holderId &&
            snapshot.services.includes(service) &&
            snapshot.createdAt.getTime() > job.createdAt.getTime(),
        ),
      ),
    )
    .map((job) => job.id);
}

/** The builds prune must leave: the row's current and previous, and every build an open reference names. */
export function protectedBuildIds(
  row: { buildId: string | null; previousBuildId: string | null },
  references: readonly BuildReference[],
): Set<string> {
  const ids = new Set<string>();
  if (row.buildId) ids.add(row.buildId);
  if (row.previousBuildId) ids.add(row.previousBuildId);
  for (const reference of references) {
    if (reference.resolvedAt === null) ids.add(reference.buildId);
  }
  return ids;
}
