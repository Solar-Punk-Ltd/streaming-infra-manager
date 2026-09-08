import type { Pool, PoolClient } from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { BUNDLED_VERSION_NAME, parseStackContract } from '@streaming-infra-manager/common';

import { Profile, ProfileStatus } from '../../types/index.js';
import { ProfileConfigError } from '../errors/index.js';
import { PROFILE_COLUMNS } from '../profileSql.js';

import {
  type BuildDescriptor,
  type BuildLedger,
  type BuildReferenceReader,
  BUNDLED_BUILD_ID,
  type ClaimedDeploy,
  type MountObserver,
  type Observation,
} from './buildLedger.js';
import {
  type BuildReference,
  buildIdOfRoot,
  commitOfRoot,
  coveredJobReferences,
} from './buildReferences.js';
import { readBuildManifest } from './buildManifest.js';
import { deployRootProblem, stackRootOf } from './stackPaths.js';
import type { StackVersionRecord } from './StackVersionRepository.js';
import { readPendingShipmentBuildIds } from './PostgresBundledShipmentRepository.js';

const REFERENCE_COLUMNS = `
  id, version_id, build_id, holder_kind, holder_id, services, created_at, resolved_at
`;

interface ReferenceRow {
  id: number;
  version_id: number;
  build_id: string;
  holder_kind: BuildReference['holderKind'];
  holder_id: string;
  services: string[];
  created_at: Date;
  resolved_at: Date | null;
}

interface DeploySnapshotRow {
  id: number;
  name: string;
  root_path: string | null;
  layout: StackVersionRecord['layout'];
  build_id: string | null;
  commit_sha: string | null;
  contract: unknown;
}

function deploySnapshotOf(version: StackVersionRecord) {
  return {
    id: version.id,
    name: version.name,
    rootPath: version.rootPath,
    layout: version.layout,
    buildId: version.buildId,
    commitSha: version.commitSha,
    contract: version.contract,
  };
}

function toReference(row: ReferenceRow): BuildReference {
  return {
    id: row.id,
    versionId: row.version_id,
    buildId: row.build_id,
    holderKind: row.holder_kind,
    holderId: row.holder_id,
    services: row.services,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

/**
 * The build ledger in Postgres. A claim takes a share lock on the version
 * row before it moves the profile and inserts the job reference, in one
 * transaction, so a prune that takes the row's update lock either sees the
 * reference or runs before the claim, which then reads the row as prune
 * left it. Observation writes what the containers mount and resolves the
 * job references the new snapshots cover.
 */
export class PostgresBuildLedger implements BuildLedger, BuildReferenceReader {
  constructor(
    private readonly pool: Pool,
    private readonly observer: MountObserver,
    private readonly versionsRoot: string,
  ) {}

  async cancelUnstarted(profileName: string, referenceId: number): Promise<void> {
    await this.pool.query(
      "UPDATE build_references SET resolved_at = NOW() WHERE id = $1 AND holder_kind = 'job' AND holder_id = $2 AND resolved_at IS NULL",
      [referenceId, profileName],
    );
  }

  async claim(
    profileName: string,
    from: readonly ProfileStatus[],
    version: StackVersionRecord | null,
    services: readonly string[],
  ): Promise<ClaimedDeploy | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (version) {
        await this.validateSnapshot(client, profileName, version);
      }
      const claimed = await client.query<Profile>(
        `UPDATE profiles
            SET status = 'DEPLOYING', last_error = NULL, last_error_at = NULL, updated_at = NOW()
          WHERE name = $1 AND status = ANY($2::text[])
          RETURNING ${PROFILE_COLUMNS}`,
        [profileName, from],
      );
      const profile = claimed.rows[0];
      if (!profile) {
        await client.query('ROLLBACK');
        return null;
      }
      const descriptor = await this.insertJobReference(client, profileName, version, services);
      await client.query('COMMIT');
      return { profile, descriptor };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async describe(
    profileName: string,
    version: StackVersionRecord | null,
    services: readonly string[],
  ): Promise<BuildDescriptor> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (version) {
        await this.validateSnapshot(client, profileName, version);
      }
      const descriptor = await this.insertJobReference(client, profileName, version, services);
      await client.query('COMMIT');
      return descriptor;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** A publication or prune may finish while the caller waits for a connection. */
  private async validateSnapshot(client: PoolClient, profileName: string, version: StackVersionRecord): Promise<void> {
    const result = await client.query<DeploySnapshotRow>(
      `SELECT id, name, root_path, layout, build_id, commit_sha, contract
         FROM stack_versions WHERE id = $1 FOR SHARE`,
      [version.id],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ProfileConfigError(profileName, `Stack version ${version.name} (${version.id}) no longer exists. No deployment was started.`);
    }
    const locked = {
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      layout: row.layout,
      buildId: row.build_id,
      commitSha: row.commit_sha,
      contract: parseStackContract(row.contract),
    };
    if (!isDeepStrictEqual(deploySnapshotOf(version), locked)) {
      throw new ProfileConfigError(profileName, `Stack version ${version.name} changed after build ${version.buildId ?? version.commitSha ?? 'unknown'} was selected. Review the current version before deploying.`);
    }
    const problem = deployRootProblem(version);
    if (problem) throw new ProfileConfigError(profileName, problem);
    if (version.layout === 'builds' && version.rootPath !== null) {
      const { manifest } = readBuildManifest(stackRootOf(version));
      if (manifest?.buildId !== version.buildId || manifest?.commit !== version.commitSha) {
        throw new ProfileConfigError(profileName, `Build ${version.buildId} of ${version.name} has a manifest that does not match its selected identity. No deployment was started.`);
      }
    }
  }

  private async insertJobReference(
    client: PoolClient,
    profileName: string,
    version: StackVersionRecord | null,
    services: readonly string[],
  ): Promise<BuildDescriptor> {
    const root = stackRootOf(version ?? { rootPath: null });
    if (!version) return { version, buildId: BUNDLED_BUILD_ID, root, referenceId: null };
    const buildId = buildIdOfRoot(this.versionsRoot, root);
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO build_references (version_id, build_id, holder_kind, holder_id, services)
       VALUES ($1, $2, 'job', $3, $4::text[])
       RETURNING id`,
      [version.id, buildId, profileName, [...services]],
    );
    return { version, buildId, root, referenceId: inserted.rows[0]?.id ?? null };
  }

  async observe(profileName: string, services: readonly string[]): Promise<Observation[]> {
    // Every question to Docker first, so a daemon that does not answer
    // leaves nothing half written.
    const mounted: { service: string; root: string }[] = [];
    for (const service of services) {
      const root = await this.observer.mountedRootOf(profileName, service);
      if (root) mounted.push({ service, root });
    }
    const observations: Observation[] = mounted.map(({ service, root }) => ({
      service,
      buildId: buildIdOfRoot(this.versionsRoot, root),
      commit: commitOfRoot(root),
    }));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const { service, root } of mounted) {
        const versionId = await this.versionOfRoot(client, root);
        if (versionId === null) continue;
        await client.query(
          `INSERT INTO build_references (version_id, build_id, holder_kind, holder_id, services)
           VALUES ($1, $2, 'snapshot', $3, $4::text[])`,
          [versionId, buildIdOfRoot(this.versionsRoot, root), `${profileName}/${service}`, [service]],
        );
      }
      // A newer snapshot of a service replaces the older one of the same
      // service: the older no longer describes what runs.
      if (mounted.length > 0) {
        await client.query(
          `UPDATE build_references SET resolved_at = NOW()
            WHERE holder_kind = 'snapshot' AND resolved_at IS NULL AND holder_id = ANY($1::text[])
              AND id < (SELECT MAX(id) FROM build_references b WHERE b.holder_id = build_references.holder_id)`,
          [mounted.map(({ service }) => `${profileName}/${service}`)],
        );
      }
      const own = await client.query<ReferenceRow>(
        `SELECT ${REFERENCE_COLUMNS} FROM build_references
          WHERE resolved_at IS NULL AND (holder_id = $1 OR holder_id LIKE $2)`,
        [profileName, `${profileName}/%`],
      );
      const covered = coveredJobReferences(own.rows.map(toReference));
      if (covered.length > 0) {
        await client.query(
          'UPDATE build_references SET resolved_at = NOW() WHERE id = ANY($1::int[])',
          [covered],
        );
      }
      await client.query('COMMIT');
      return observations;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async observeAll(): Promise<void> {
    const open = await this.pool.query<{ holder_id: string; services: string[] }>(
      `SELECT holder_id, services FROM build_references
        WHERE holder_kind = 'job' AND resolved_at IS NULL`,
    );
    const byProfile = new Map<string, Set<string>>();
    for (const row of open.rows) {
      const services = byProfile.get(row.holder_id) ?? new Set<string>();
      for (const service of row.services) services.add(service);
      byProfile.set(row.holder_id, services);
    }
    for (const [profileName, services] of byProfile) {
      await this.observe(profileName, [...services]);
    }
  }

  async openReferences(versionId: number): Promise<BuildReference[]> {
    const result = await this.pool.query<ReferenceRow>(
      `SELECT ${REFERENCE_COLUMNS} FROM build_references WHERE version_id = $1 AND resolved_at IS NULL`,
      [versionId],
    );
    return result.rows.map(toReference);
  }

  async lockVersion<T>(versionId: number, work: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM stack_versions WHERE id = $1 FOR UPDATE', [versionId]);
      const result = await work();
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async pendingShipmentBuildIds(versionId: number): Promise<string[]> {
    return readPendingShipmentBuildIds(this.pool, versionId);
  }

  /** The version a root belongs to, by the version name in its path, or null for the bundled checkout and anything else. */
  private async versionOfRoot(client: PoolClient, root: string): Promise<number | null> {
    if (root === stackRootOf({ rootPath: null })) {
      const found = await client.query<{ id: number }>('SELECT id FROM stack_versions WHERE name = $1', [BUNDLED_VERSION_NAME]);
      return found.rows[0]?.id ?? null;
    }
    if (!root.startsWith(`${this.versionsRoot}/`)) return null;
    const first = root.slice(this.versionsRoot.length + 1).split('/')[0] ?? '';
    const name = first.replace(/\.(builds|repo)$/, '');
    const found = await client.query<{ id: number }>('SELECT id FROM stack_versions WHERE name = $1', [name]);
    return found.rows[0]?.id ?? null;
  }
}
