import type { Pool } from 'pg';

import {
  type AttemptOutcome,
  type DeployAttempt,
  whyAdmissionIsRefused,
} from './deployAttempts.js';
import type { DeployAttemptRepository, NewDeployAttempt } from './DeployAttemptRepository.js';
import { DeployAttemptRefusedError } from './errors/index.js';

const COLUMNS = `
  id, daemon_id, target, project, job_id, kind, services, pre_job_container_ids,
  state, reason, started_at, resolved_at, released_by
`;

interface AttemptRow {
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

function toAttempt(row: AttemptRow): DeployAttempt {
  return {
    id: row.id,
    daemonId: row.daemon_id,
    target: row.target,
    project: row.project,
    jobId: row.job_id,
    kind: row.kind,
    services: row.services,
    preJobContainerIds: row.pre_job_container_ids,
    state: row.state,
    reason: row.reason,
    startedAt: row.started_at,
    resolvedAt: row.resolved_at,
    releasedBy: row.released_by,
  };
}

/**
 * The attempts table. `open` takes an advisory lock keyed by the daemon for
 * its transaction, reads the daemon's unresolved attempts, applies the
 * admission rules and inserts, so two attempts admitted together cannot
 * both pass the rules on the same read.
 */
export class PostgresDeployAttemptRepository implements DeployAttemptRepository {
  constructor(private readonly pool: Pool) {}

  async open(attempt: NewDeployAttempt): Promise<DeployAttempt> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`deploy-attempts:${attempt.daemonId}`]);
      const unresolved = await client.query<AttemptRow>(
        `SELECT ${COLUMNS} FROM deploy_attempts WHERE daemon_id = $1 AND state <> 'released'`,
        [attempt.daemonId],
      );
      const refusal = whyAdmissionIsRefused(attempt, unresolved.rows.map(toAttempt));
      if (refusal) {
        await client.query('ROLLBACK');
        throw new DeployAttemptRefusedError(attempt.project, refusal);
      }
      const inserted = await client.query<AttemptRow>(
        `INSERT INTO deploy_attempts (daemon_id, project, job_id, kind, services, pre_job_container_ids, target)
         VALUES ($1, $2, $3, $4, $5::text[], $6::text[], $7)
         RETURNING ${COLUMNS}`,
        [
          attempt.daemonId,
          attempt.project,
          attempt.jobId,
          attempt.kind,
          [...attempt.services],
          [...attempt.preJobContainerIds],
          attempt.target ?? null,
        ],
      );
      await client.query('COMMIT');
      return toAttempt(inserted.rows[0]!);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async findByJob(jobId: string): Promise<DeployAttempt | null> {
    const result = await this.pool.query<AttemptRow>(
      `SELECT ${COLUMNS} FROM deploy_attempts WHERE job_id = $1`,
      [jobId],
    );
    return result.rows[0] ? toAttempt(result.rows[0]) : null;
  }

  async listUnresolved(daemonId?: string): Promise<DeployAttempt[]> {
    const result = await this.pool.query<AttemptRow>(
      `SELECT ${COLUMNS} FROM deploy_attempts WHERE ($1::text IS NULL OR daemon_id = $1) AND state <> 'released' ORDER BY id ASC`,
      [daemonId ?? null],
    );
    return result.rows.map(toAttempt);
  }

  async listBlocked(): Promise<DeployAttempt[]> {
    const result = await this.pool.query<AttemptRow>(
      `SELECT ${COLUMNS} FROM deploy_attempts WHERE state = 'blocked' ORDER BY id ASC`,
    );
    return result.rows.map(toAttempt);
  }

  async resolve(id: number, outcome: AttemptOutcome): Promise<DeployAttempt | null> {
    const result = await this.pool.query<AttemptRow>(
      `UPDATE deploy_attempts SET state = $2, reason = $3, resolved_at = NOW()
        WHERE id = $1 AND state = 'open'
        RETURNING ${COLUMNS}`,
      [id, outcome.state, outcome.reason],
    );
    return result.rows[0] ? toAttempt(result.rows[0]) : null;
  }

  async release(id: number, by: string): Promise<DeployAttempt | null> {
    const result = await this.pool.query<AttemptRow>(
      `UPDATE deploy_attempts SET state = 'released', released_by = $2, resolved_at = NOW()
        WHERE id = $1 AND state <> 'released'
        RETURNING ${COLUMNS}`,
      [id, by],
    );
    return result.rows[0] ? toAttempt(result.rows[0]) : null;
  }

  async releaseProject(daemonId: string, project: string, by: string): Promise<DeployAttempt[]> {
    const result = await this.pool.query<AttemptRow>(
      `UPDATE deploy_attempts SET state = 'released', released_by = $3, resolved_at = NOW()
        WHERE daemon_id = $1 AND project = $2 AND state <> 'released'
        RETURNING ${COLUMNS}`,
      [daemonId, project, by],
    );
    return result.rows.map(toAttempt);
  }
}
