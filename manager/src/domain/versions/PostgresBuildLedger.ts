import type { Pool, PoolClient } from 'pg';

import { Profile, ProfileStatus } from '../../types/index.js';
import { PROFILE_COLUMNS } from '../profileSql.js';

import {
  type BuildDescriptor,
  type BuildLedger,
  BUNDLED_BUILD_ID,
  type ClaimedDeploy,
  type MountObserver,
} from './buildLedger.js';
import {
  type BuildReference,
  buildIdOfRoot,
  coveredJobReferences,
} from './buildReferences.js';
import { stackRootOf } from './stackPaths.js';
import type { StackVersionRecord } from './StackVersionRepository.js';

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
export class PostgresBuildLedger implements BuildLedger {
  constructor(
    private readonly pool: Pool,
    private readonly observer: MountObserver,
    private readonly versionsRoot: string,
  ) {}

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
        await client.query('SELECT id FROM stack_versions WHERE id = $1 FOR SHARE', [version.id]);
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
        await client.query('SELECT id FROM stack_versions WHERE id = $1 FOR SHARE', [version.id]);
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

  async observe(profileName: string, services: readonly string[]): Promise<void> {
    // Every question to Docker first, so a daemon that does not answer
    // leaves nothing half written.
    const mounted: { service: string; root: string }[] = [];
    for (const service of services) {
      const root = await this.observer.mountedRootOf(profileName, service);
      if (root) mounted.push({ service, root });
    }
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

  /** The version a root belongs to, by the version name in its path, or null for the bundled checkout and anything else. */
  private async versionOfRoot(client: PoolClient, root: string): Promise<number | null> {
    if (!root.startsWith(`${this.versionsRoot}/`)) return null;
    const first = root.slice(this.versionsRoot.length + 1).split('/')[0] ?? '';
    const name = first.replace(/\.(builds|repo)$/, '');
    const found = await client.query<{ id: number }>('SELECT id FROM stack_versions WHERE name = $1', [name]);
    return found.rows[0]?.id ?? null;
  }
}
