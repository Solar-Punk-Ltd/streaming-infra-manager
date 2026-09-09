import type { Pool, PoolClient } from 'pg';
import { BUNDLED_VERSION_NAME } from '@streaming-infra-manager/common';

import { Profile, ProfileStatus } from '../../types/index.js';
import { ProfileConfigError } from '../errors/index.js';

import {
  type BuildDescriptor,
  type BuildLedger,
  type BuildReferenceReader,
  type ClaimedDeploy,
  type DeployClaimOwnership,
  type ExpectedDeployOwner,
  type MountObserver,
  type Observation,
} from './buildLedger.js';
import {
  type BuildReference,
  buildIdOfRoot,
  commitOfRoot,
  coveredJobReferences,
} from './buildReferences.js';
import { stackRootOf } from './stackPaths.js';
import type { StackVersionRecord } from './StackVersionRepository.js';
import { cancelBuildJob, claimBuildJob } from './buildJobClaim.js';

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
    ownership: DeployClaimOwnership,
  ): Promise<ClaimedDeploy | null> {
    const input = structuredClone({ profileName, version, services, ownership,
      transition: { from, intent: ownership.intent, supersedeReason: ownership.supersedeReason } });
    return this.transaction(client => claimBuildJob(client, input, this.versionsRoot));
  }

  async describe(
    profileName: string,
    version: StackVersionRecord | null,
    services: readonly string[],
    ownership: ExpectedDeployOwner,
  ): Promise<BuildDescriptor> {
    const input = structuredClone({ profileName, version, services, ownership, transition: null });
    return this.transaction(async client => {
      const captured = await claimBuildJob(client, input, this.versionsRoot);
      if (!captured) throw new ProfileConfigError(profileName, 'The deployment no longer owns this initial build job. No deployment was started.');
      return captured.descriptor;
    });
  }

  async cancelClaim(profile: Pick<Profile, 'name' | 'instance_id' | 'intent_revision'>, referenceId: number, previousStatus: ProfileStatus): Promise<Profile | null> {
    const owner = { name: profile.name, instance_id: profile.instance_id, intent_revision: profile.intent_revision };
    return this.transaction(client => cancelBuildJob(client, owner, referenceId, previousStatus));
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
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
