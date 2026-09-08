import { randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { targetAlias } from '../ports/DeployTargets.js';
import { assertExecutionId, assertExecutionRegistration, executionRootPath, type ExecutionRootRecord, type ExecutionRootRegistration, type ExecutionRootState } from './ExecutionRoot.js';
import { buildDirFor } from './stackPaths.js';

interface ExecutionRow {
  execution_id: string; version_id: number; build_id: string; commit_sha: string; source_root: string; artifact_digest: string;
  profile_name: string; profile_instance_id: string; intent_revision: number; profile_status: ExecutionRootRegistration['profile']['status'];
  job_reference_id: number; target_alias: string; daemon_id: string; project: string; action: ExecutionRootRegistration['action'];
  services: string[]; root_path: string; reference_id: number; state: ExecutionRootState; copy_token: string | null; created_at: Date;
}
function toRecord(row: ExecutionRow): ExecutionRootRecord {
  return {
    executionId: row.execution_id,
    source: { versionId: row.version_id, buildId: row.build_id, commit: row.commit_sha, root: row.source_root, artifactDigest: row.artifact_digest },
    profile: { name: row.profile_name, instanceId: row.profile_instance_id, intentRevision: row.intent_revision, status: row.profile_status },
    jobReferenceId: row.job_reference_id, target: { alias: row.target_alias, daemonId: row.daemon_id }, project: row.project,
    action: row.action, services: row.services, root: row.root_path, referenceId: row.reference_id, state: row.state, copyToken: row.copy_token, createdAt: row.created_at,
  };
}
function identityOf(input: ExecutionRootRegistration) {
  return [input.executionId, input.source, input.profile, input.jobReferenceId, input.target, input.action, input.services];
}

/** Source holds outlive the script. This bounded API never retires a possibly launched execution. */
export class PostgresExecutionRootRepository {
  constructor(private readonly pool: Pool, private readonly executionsParent: string) {
    executionRootPath(executionsParent, '00000000-0000-0000-0000-000000000000');
  }

  async find(id: string): Promise<ExecutionRootRecord | null> {
    assertExecutionId(id);
    const result = await this.pool.query<ExecutionRow>('SELECT * FROM execution_roots WHERE execution_id = $1', [id]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async register(input: ExecutionRootRegistration): Promise<ExecutionRootRecord> {
    assertExecutionRegistration(input);
    targetAlias(input.target.alias);
    const selected = structuredClone(input);
    const root = executionRootPath(this.executionsParent, selected.executionId);
    const same = (existing: ExecutionRootRecord) => {
      if (!isDeepStrictEqual(identityOf(existing), identityOf(selected)) || existing.root !== root) throw new Error('Execution UUID already records a different identity.');
      return existing;
    };
    const replay = await this.find(selected.executionId);
    if (replay) return same(replay);
    return this.transaction(async client => {
      await this.lockOwnership(client, selected);
      const existing = await this.readLocked(client, selected.executionId);
      if (existing) return same(existing);
      const used = await client.query('SELECT 1 FROM execution_roots WHERE job_reference_id = $1', [selected.jobReferenceId]);
      if (used.rowCount) throw new Error('The job already owns an execution root.');
      const reference = await client.query<{ id: number }>(
        `INSERT INTO build_references (version_id, build_id, holder_kind, holder_id, services, profile_instance_id, intent_revision)
         VALUES ($1, $2, 'execution', $3, $4::text[], $5, $6) RETURNING id`,
        [selected.source.versionId, selected.source.buildId, selected.executionId, selected.services, selected.profile.instanceId, selected.profile.intentRevision],
      );
      const inserted = await client.query<ExecutionRow>(
        `INSERT INTO execution_roots (execution_id, version_id, build_id, commit_sha, source_root, artifact_digest,
          profile_name, profile_instance_id, intent_revision, profile_status, job_reference_id, target_alias, daemon_id,
          project, action, services, root_path, reference_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$7,$14,$15::text[],$16,$17) RETURNING *`,
        [selected.executionId, selected.source.versionId, selected.source.buildId, selected.source.commit, selected.source.root, selected.source.artifactDigest,
          selected.profile.name, selected.profile.instanceId, selected.profile.intentRevision, selected.profile.status, selected.jobReferenceId,
          selected.target.alias, selected.target.daemonId, selected.action, selected.services, root, reference.rows[0]!.id],
      );
      return toRecord(inserted.rows[0]!);
    });
  }

  async beginCopy(id: string): Promise<ExecutionRootRecord | null> {
    return this.changeOwned(id, ['registered'], async (client, record) => this.updateState(client, record, 'copying', randomUUID()));
  }

  async markReady(id: string, copyToken: string, digest: string): Promise<ExecutionRootRecord | null> {
    const result = await this.changeOwned(id, ['copying'], async (client, record) => {
      if (record.copyToken !== copyToken || record.source.artifactDigest !== digest) throw new Error('Copy ownership or verified source digest changed.');
      return this.updateState(client, record, 'ready', copyToken);
    });
    if (!result) throw new Error('Execution is not owned by a preparing copy.');
    return result;
  }

  async claimLaunch(id: string): Promise<ExecutionRootRecord | null> {
    return this.changeOwned(id, ['ready'], async (client, record) => this.updateState(client, record, 'launch-uncertain', record.copyToken));
  }

  async claimUnstartedCleanup(id: string): Promise<ExecutionRootRecord | null> {
    assertExecutionId(id);
    const result = await this.pool.query<ExecutionRow>(
      "UPDATE execution_roots SET state = 'deleting' WHERE execution_id = $1 AND state IN ('registered', 'ready') RETURNING *", [id],
    );
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async completeCleanup(id: string, removeOwnedRoot: (record: ExecutionRootRecord) => Promise<void>): Promise<ExecutionRootRecord> {
    assertExecutionId(id);
    return this.transaction(async client => {
      const record = await this.readLocked(client, id);
      if (!record) throw new Error('Execution was not found.');
      if (record.state === 'released') return record;
      if (record.state !== 'deleting') throw new Error('Execution has not exclusively claimed unstarted cleanup.');
      await removeOwnedRoot(record);
      const released = await client.query(
        `UPDATE build_references SET resolved_at = NOW()
         WHERE id = $1 AND holder_kind = 'execution' AND holder_id = $2 AND version_id = $3 AND build_id = $4 AND resolved_at IS NULL`,
        [record.referenceId, id, record.source.versionId, record.source.buildId],
      );
      if (released.rowCount !== 1) throw new Error('Execution source hold could not be resolved.');
      return this.updateState(client, record, 'released', record.copyToken);
    });
  }

  private async changeOwned(
    id: string, allowed: ExecutionRootState[],
    change: (client: PoolClient, record: ExecutionRootRecord) => Promise<ExecutionRootRecord>,
  ): Promise<ExecutionRootRecord | null> {
    const snapshot = await this.find(id);
    if (!snapshot || !allowed.includes(snapshot.state)) return null;
    return this.transaction(async client => {
      await this.lockOwnership(client, snapshot);
      const record = await this.readLocked(client, id);
      if (!record || !allowed.includes(record.state)) return null;
      if (!isDeepStrictEqual(identityOf(record), identityOf(snapshot)) || record.root !== snapshot.root) throw new Error('Execution identity changed.');
      return change(client, record);
    });
  }

  private async lockOwnership(client: PoolClient, input: ExecutionRootRegistration): Promise<void> {
    const version = (await client.query<{ root_path: string | null; layout: string }>(
      'SELECT root_path, layout FROM stack_versions WHERE id = $1 FOR SHARE', [input.source.versionId],
    )).rows[0];
    if (!version || version.layout !== 'builds' || !version.root_path ||
        buildDirFor(dirname(version.root_path), basename(version.root_path), input.source.buildId) !== input.source.root) throw new Error('Execution source version or artifact root changed.');
    const profile = (await client.query<{ instance_id: string; intent_revision: number; status: string; host: string | null; stack_version_id: number; deploy_job_reference_id: number | null }>(
      'SELECT instance_id, intent_revision, status, host, stack_version_id, deploy_job_reference_id FROM profiles WHERE name = $1 FOR UPDATE', [input.profile.name],
    )).rows[0];
    const actionStatus = { deploy: 'DEPLOYING', stop: 'STOPPING', remove: 'REMOVING', health: input.profile.status }[input.action];
    if (!profile || profile.instance_id !== input.profile.instanceId || profile.intent_revision !== input.profile.intentRevision ||
        profile.status !== input.profile.status || profile.status !== actionStatus || profile.stack_version_id !== input.source.versionId ||
        profile.deploy_job_reference_id !== input.jobReferenceId || targetAlias(profile.host) !== input.target.alias) throw new Error('Current deployment no longer owns this execution.');
    const job = (await client.query<{ version_id: number; build_id: string; holder_kind: string; holder_id: string; services: string[]; profile_instance_id: string | null; intent_revision: number | null; resolved_at: Date | null }>(
      'SELECT * FROM build_references WHERE id = $1 FOR UPDATE', [input.jobReferenceId],
    )).rows[0];
    if (!job || job.resolved_at !== null || job.holder_kind !== 'job' || job.holder_id !== input.profile.name ||
        job.version_id !== input.source.versionId || job.build_id !== input.source.buildId || !isDeepStrictEqual(job.services, input.services) ||
        job.profile_instance_id !== input.profile.instanceId || job.intent_revision !== input.profile.intentRevision) throw new Error('Execution requires its exact unresolved and explicitly owned job hold.');
    const target = (await client.query<{ daemon_id: string | null; verified_at: Date | null }>(
      'SELECT daemon_id, verified_at FROM deploy_targets WHERE alias = $1 FOR SHARE', [input.target.alias],
    )).rows[0];
    if (!target?.verified_at || target.daemon_id !== input.target.daemonId) throw new Error('Execution target daemon is no longer verified.');
  }

  private async readLocked(client: PoolClient, id: string): Promise<ExecutionRootRecord | null> {
    const result = await client.query<ExecutionRow>('SELECT * FROM execution_roots WHERE execution_id = $1 FOR UPDATE', [id]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }
  private async updateState(client: PoolClient, record: ExecutionRootRecord, state: ExecutionRootState, copyToken: string | null): Promise<ExecutionRootRecord> {
    const result = await client.query<ExecutionRow>(
      'UPDATE execution_roots SET state = $2, copy_token = $3 WHERE execution_id = $1 RETURNING *', [record.executionId, state, copyToken],
    );
    return toRecord(result.rows[0]!);
  }
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
}
