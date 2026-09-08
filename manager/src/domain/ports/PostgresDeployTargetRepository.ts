import type { Pool } from 'pg';

import { DAEMON_CHANGED, type DeployTargetRecord, type DeployTargetRepository } from './DeployTargetRepository.js';

const COLUMNS = 'alias, daemon_id, verified_at, last_error';
interface TargetRow {
  alias: string;
  daemon_id: string | null;
  verified_at: Date | null;
  last_error: string | null;
}
const toTarget = (row: TargetRow): DeployTargetRecord => ({
  alias: row.alias,
  daemonId: row.daemon_id,
  verifiedAt: row.verified_at,
  lastError: row.last_error,
});

export class PostgresDeployTargetRepository implements DeployTargetRepository {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<DeployTargetRecord[]> {
    const result = await this.pool.query<TargetRow>(`SELECT ${COLUMNS} FROM deploy_targets ORDER BY alias`);
    return result.rows.map(toTarget);
  }

  async find(alias: string): Promise<DeployTargetRecord | null> {
    const result = await this.pool.query<TargetRow>(`SELECT ${COLUMNS} FROM deploy_targets WHERE alias = $1`, [alias]);
    return result.rows[0] ? toTarget(result.rows[0]) : null;
  }

  async verified(alias: string, daemonId: string): Promise<DeployTargetRecord> {
    const result = await this.pool.query<TargetRow>(
      `INSERT INTO deploy_targets (alias, daemon_id, verified_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (alias) DO UPDATE SET
         daemon_id = COALESCE(deploy_targets.daemon_id, EXCLUDED.daemon_id),
         verified_at = CASE
           WHEN deploy_targets.daemon_id IS NULL OR deploy_targets.daemon_id = EXCLUDED.daemon_id
           THEN NOW() ELSE NULL END,
         last_error = CASE
           WHEN deploy_targets.daemon_id IS NULL OR deploy_targets.daemon_id = EXCLUDED.daemon_id
           THEN NULL ELSE $3 END
       RETURNING ${COLUMNS}`,
      [alias, daemonId, DAEMON_CHANGED],
    );
    return toTarget(result.rows[0]!);
  }

  async failed(alias: string, reason: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO deploy_targets (alias, last_error) VALUES ($1, $2)
       ON CONFLICT (alias) DO UPDATE SET verified_at = NULL, last_error = EXCLUDED.last_error`,
      [alias, reason],
    );
  }
}
