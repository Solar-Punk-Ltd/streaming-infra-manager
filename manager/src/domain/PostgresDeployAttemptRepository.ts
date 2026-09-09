import type { Pool, PoolClient } from 'pg';

import {
  type AttemptOutcome,
  type DeployAttempt,
} from './deployAttempts.js';
import type { AttemptSnapshotToken, DeployAttemptRepository, NewDeployAttempt } from './DeployAttemptRepository.js';
import { ATTEMPT_COLUMNS as COLUMNS, type AttemptRow, captureAttemptSnapshotToken, openDeployAttempt, toAttempt } from './deployAttemptSql.js';

/**
 * The attempts table. `open` takes an advisory lock keyed by the daemon for
 * its transaction, reads the daemon's unresolved attempts, applies the
 * admission rules and inserts, so two attempts admitted together cannot
 * both pass the rules on the same read.
 */
export class PostgresDeployAttemptRepository implements DeployAttemptRepository {
  constructor(private readonly pool: Pool) {}

  async open(attempt: NewDeployAttempt): Promise<DeployAttempt> {
    const captured = structuredClone(attempt);
    return this.transaction(client => openDeployAttempt(client, captured));
  }

  async captureSnapshotToken(daemonId: string, project: string): Promise<AttemptSnapshotToken> {
    return this.transaction(client => captureAttemptSnapshotToken(client, daemonId, project));
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
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
