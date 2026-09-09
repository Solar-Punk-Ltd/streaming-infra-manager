import type { PoolClient } from 'pg';
import type { AttemptSnapshotToken, NewDeployAttempt } from './DeployAttemptRepository.js';
import { type DeployAttempt, whyAdmissionIsRefused } from './deployAttempts.js';
import { DeployAttemptRefusedError } from './errors/index.js';

export const ATTEMPT_COLUMNS = `
  id, daemon_id, target, project, job_id, kind, services, pre_job_container_ids,
  state, reason, started_at, resolved_at, released_by
`;

export interface AttemptRow {
  id: number;
  daemon_id: string;
  target: string | null;
  project: string;
  job_id: string;
  kind: DeployAttempt['kind'];
  services: string[];
  pre_job_container_ids: string[];
  state: DeployAttempt['state'];
  reason: string | null;
  started_at: Date;
  resolved_at: Date | null;
  released_by: string | null;
}

export function toAttempt(row: AttemptRow): DeployAttempt {
  return {
    id: row.id, daemonId: row.daemon_id, target: row.target, project: row.project,
    jobId: row.job_id, kind: row.kind, services: row.services,
    preJobContainerIds: row.pre_job_container_ids, state: row.state, reason: row.reason,
    startedAt: row.started_at, resolvedAt: row.resolved_at, releasedBy: row.released_by,
  };
}

export async function lockAttemptDaemon(client: PoolClient, daemonId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`deploy-attempts:${daemonId}`]);
}

/** Retained attempt history is a snapshot generation, never a deployment ownership token. */
export async function captureAttemptSnapshotToken(client: PoolClient, daemonId: string, project: string): Promise<AttemptSnapshotToken> {
  await lockAttemptDaemon(client, daemonId);
  const result = await client.query<{ latest: string | null; unresolved: boolean }>(
    `SELECT MAX(id)::text AS latest, COALESCE(bool_or(state <> 'released'), false) AS unresolved
       FROM deploy_attempts WHERE daemon_id = $1 AND project = $2`, [daemonId, project],
  );
  const row = result.rows[0]!;
  if (row.unresolved) {
    throw new DeployAttemptRefusedError(project, `${project} has an unresolved deploy attempt. Its container snapshot cannot be captured yet.`);
  }
  return { daemonId, project, latestAttemptId: row.latest };
}

/** The caller owns the transaction. All attempt producers take the same daemon lock. */
export async function openDeployAttempt(client: PoolClient, input: NewDeployAttempt): Promise<DeployAttempt> {
  const attempt = structuredClone(input);
  await lockAttemptDaemon(client, attempt.daemonId);
  if (attempt.snapshotToken) {
    const token = attempt.snapshotToken;
    if (token.daemonId !== attempt.daemonId || token.project !== attempt.project ||
        (token.latestAttemptId !== null && !/^[1-9]\d*$/.test(token.latestAttemptId))) {
      throw new DeployAttemptRefusedError(attempt.project, 'The container snapshot token does not match this target and project.');
    }
    const current = await captureAttemptSnapshotToken(client, attempt.daemonId, attempt.project);
    if (current.latestAttemptId !== token.latestAttemptId) {
      throw new DeployAttemptRefusedError(attempt.project, 'Deploy attempt history changed while the container snapshot was read. Capture a fresh snapshot before retrying.');
    }
  }
  const unresolved = await client.query<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM deploy_attempts WHERE daemon_id = $1 AND state <> 'released'`, [attempt.daemonId],
  );
  const refusal = whyAdmissionIsRefused(attempt, unresolved.rows.map(toAttempt));
  if (refusal) throw new DeployAttemptRefusedError(attempt.project, refusal);
  const inserted = await client.query<AttemptRow>(
    `INSERT INTO deploy_attempts (daemon_id, project, job_id, kind, services, pre_job_container_ids, target)
     VALUES ($1, $2, $3, $4, $5::text[], $6::text[], $7) RETURNING ${ATTEMPT_COLUMNS}`,
    [attempt.daemonId, attempt.project, attempt.jobId, attempt.kind,
      [...attempt.services], [...attempt.preJobContainerIds], attempt.target ?? null],
  );
  return toAttempt(inserted.rows[0]!);
}
