import {
  parseStackContract,
  type StackContract,
} from '@streaming-infra-manager/common';
import type { Pool } from 'pg';

import type {
  BuildOutcome,
  NewStackVersion,
  StackVersionRecord,
  StackVersionRepository,
  StackVersionUsage,
} from './StackVersionRepository.js';

const VERSION_COLUMNS = `
  id, name, git_ref, commit_sha, status, root_path, contract,
  is_default, tested, built_at, last_error, created_at
`;

/**
 * A row as pg hands it over. `contract` is unknown on purpose: it comes out of
 * a JSONB column, so the compiler has never seen its shape and a version built
 * by an older manager may hold one this manager does not know.
 */
interface StackVersionDbRow {
  id: number;
  name: string;
  git_ref: string;
  commit_sha: string | null;
  status: string;
  root_path: string | null;
  contract: unknown;
  is_default: boolean;
  tested: boolean;
  built_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

interface StackVersionUsageDbRow extends StackVersionDbRow {
  deployments: string;
}

export class PostgresStackVersionRepository implements StackVersionRepository {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<StackVersionUsage[]> {
    const result = await this.pool.query<StackVersionUsageDbRow>(
      `SELECT ${VERSION_COLUMNS},
              (SELECT COUNT(*) FROM profiles p WHERE p.stack_version_id = v.id) AS deployments
         FROM stack_versions v
        ORDER BY v.id ASC`,
    );
    return result.rows.map((row) => ({
      ...toRecord(row),
      deployments: Number(row.deployments),
    }));
  }

  async findById(id: number): Promise<StackVersionRecord | null> {
    return this.one(
      `SELECT ${VERSION_COLUMNS} FROM stack_versions WHERE id = $1`,
      [id],
    );
  }

  async findByName(name: string): Promise<StackVersionRecord | null> {
    return this.one(
      `SELECT ${VERSION_COLUMNS} FROM stack_versions WHERE name = $1`,
      [name],
    );
  }

  async findDefault(): Promise<StackVersionRecord | null> {
    return this.one(
      `SELECT ${VERSION_COLUMNS} FROM stack_versions WHERE is_default`,
      [],
    );
  }

  async insert(version: NewStackVersion): Promise<StackVersionRecord> {
    const inserted = await this.one(
      `INSERT INTO stack_versions (name, git_ref, root_path, status)
       VALUES ($1, $2, $3, 'building')
       RETURNING ${VERSION_COLUMNS}`,
      [version.name, version.gitRef, version.rootPath],
    );
    if (!inserted) {
      throw new Error(`could not insert stack version ${version.name}`);
    }
    return inserted;
  }

  async markBuilding(id: number): Promise<StackVersionRecord | null> {
    return this.one(
      `UPDATE stack_versions
          SET status = 'building', last_error = NULL
        WHERE id = $1
        RETURNING ${VERSION_COLUMNS}`,
      [id],
    );
  }

  async markBuilt(
    id: number,
    outcome: BuildOutcome,
  ): Promise<StackVersionRecord | null> {
    // Every SET expression here is evaluated against the row as it was before
    // the update, so the `commit_sha` inside the `tested` rule is the commit
    // the approval was given for, not the one this build landed on.
    return this.one(
      `UPDATE stack_versions
          SET status = 'ready',
              tested = tested AND commit_sha IS NOT DISTINCT FROM $2,
              commit_sha = $2,
              contract = $3::jsonb,
              built_at = NOW(),
              last_error = NULL
        WHERE id = $1
        RETURNING ${VERSION_COLUMNS}`,
      [id, outcome.commitSha, JSON.stringify(outcome.contract)],
    );
  }

  async markFailed(
    id: number,
    lastError: string,
  ): Promise<StackVersionRecord | null> {
    return this.one(
      `UPDATE stack_versions
          SET status = 'failed', last_error = $2
        WHERE id = $1
        RETURNING ${VERSION_COLUMNS}`,
      [id, lastError],
    );
  }

  async failInterruptedBuilds(
    lastError: string,
  ): Promise<StackVersionRecord[]> {
    const result = await this.pool.query<StackVersionDbRow>(
      `UPDATE stack_versions
          SET status = 'failed', last_error = $1
        WHERE status = 'building'
        RETURNING ${VERSION_COLUMNS}`,
      [lastError],
    );
    return result.rows.map(toRecord);
  }

  async setCommitSha(id: number, commitSha: string | null): Promise<void> {
    // The same rule as `markBuilt`: approval names a commit, and the row is
    // read before the update, so the comparison is against the commit the
    // approval was given for.
    await this.pool.query(
      `UPDATE stack_versions
          SET tested = tested AND commit_sha IS NOT DISTINCT FROM $2,
              commit_sha = $2
        WHERE id = $1`,
      [id, commitSha],
    );
  }

  async setContract(id: number, contract: StackContract): Promise<void> {
    await this.pool.query(
      'UPDATE stack_versions SET contract = $2::jsonb WHERE id = $1',
      [id, JSON.stringify(contract)],
    );
  }

  async setDefault(id: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE stack_versions SET is_default = false WHERE is_default AND id <> $1',
        [id],
      );
      await client.query(
        'UPDATE stack_versions SET is_default = true WHERE id = $1',
        [id],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async setTested(
    id: number,
    tested: boolean,
    forCommit: string | null = null,
  ): Promise<StackVersionRecord | null> {
    return this.one(
      `UPDATE stack_versions
          SET tested = $2
        WHERE id = $1
          AND ($3::text IS NULL OR (status = 'ready' AND commit_sha = $3::text))
        RETURNING ${VERSION_COLUMNS}`,
      [id, tested, forCommit],
    );
  }

  async remove(id: number): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM stack_versions WHERE id = $1',
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deploymentNames(id: number): Promise<string[]> {
    const result = await this.pool.query<{ name: string }>(
      'SELECT name FROM profiles WHERE stack_version_id = $1 ORDER BY name ASC',
      [id],
    );
    return result.rows.map((row) => row.name);
  }

  private async one(
    sql: string,
    params: unknown[],
  ): Promise<StackVersionRecord | null> {
    const result = await this.pool.query<StackVersionDbRow>(sql, params);
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }
}

function toRecord(row: StackVersionDbRow): StackVersionRecord {
  return {
    id: row.id,
    name: row.name,
    gitRef: row.git_ref,
    commitSha: row.commit_sha,
    status: toStatus(row.status),
    rootPath: row.root_path,
    contract: parseStackContract(row.contract),
    isDefault: row.is_default,
    tested: row.tested,
    builtAt: row.built_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

/**
 * The CHECK constraint in migration 010 already refuses anything else, so a row
 * that reaches here with another value came from a hand-edited database.
 */
function toStatus(status: string): StackVersionRecord['status'] {
  if (status === 'ready' || status === 'building') return status;
  return 'failed';
}
