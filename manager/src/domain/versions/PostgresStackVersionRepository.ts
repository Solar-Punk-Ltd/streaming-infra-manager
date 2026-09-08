import {
  parseStackContract,
  type StackContract,
} from '@streaming-infra-manager/common';
import type { Pool } from 'pg';

import type {
  BuildOutcome,
  NewStackVersion,
  PublishOutcome,
  StackVersionRecord,
  StackVersionRepository,
  StackVersionUsage,
} from './StackVersionRepository.js';

const VERSION_COLUMNS = `
  id, name, git_ref, commit_sha, status, root_path, layout, build_id, previous_build_id, contract,
  is_default, tested, tested_invalidated_at, built_at, last_error, created_at
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
  layout: string;
  build_id: string | null;
  previous_build_id: string | null;
  contract: unknown;
  is_default: boolean;
  tested: boolean;
  tested_invalidated_at: Date | null;
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
              tested_invalidated_at = CASE WHEN tested AND commit_sha IS DISTINCT FROM $2
                THEN COALESCE(tested_invalidated_at, NOW()) ELSE tested_invalidated_at END,
              commit_sha = $2,
              contract = $3::jsonb,
              built_at = NOW(),
              last_error = NULL
        WHERE id = $1
        RETURNING ${VERSION_COLUMNS}`,
      [id, outcome.commitSha, JSON.stringify(outcome.contract)],
    );
  }

  async publish(id: number, outcome: PublishOutcome): Promise<StackVersionRecord | null> {
    // One statement, so the build, the commit, the contract and the layout
    // change together and a reader never sees the new build with the old
    // contract. Every SET expression reads the row as it was, which is what
    // makes the previous build and the tested rule right.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM stack_versions WHERE id = $1 FOR UPDATE', [id]);
      const result = await client.query<StackVersionDbRow>(
        `UPDATE stack_versions
            SET status = 'ready',
                layout = 'builds',
                previous_build_id = CASE
                  WHEN build_id IS NOT NULL AND build_id <> $2 THEN build_id
                  ELSE previous_build_id
                END,
                tested = tested AND build_id IS NOT DISTINCT FROM $2,
                tested_invalidated_at = CASE WHEN tested AND build_id IS DISTINCT FROM $2
                  THEN COALESCE(tested_invalidated_at, NOW()) ELSE tested_invalidated_at END,
                build_id = $2,
                commit_sha = $3,
                contract = $4::jsonb,
                built_at = NOW(),
                last_error = NULL
          WHERE id = $1
          RETURNING ${VERSION_COLUMNS}`,
        [id, outcome.buildId, outcome.commitSha, JSON.stringify(outcome.contract)],
      );
      await client.query('COMMIT');
      const row = result.rows[0];
      return row ? toRecord(row) : null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async markUpdateFailed(id: number, lastError: string): Promise<StackVersionRecord | null> {
    return this.one(
      `UPDATE stack_versions
          SET status = 'ready', last_error = $2
        WHERE id = $1
        RETURNING ${VERSION_COLUMNS}`,
      [id, lastError],
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
    // A row with a usable build keeps it: failed is for a version that has
    // nothing to deploy from.
    const result = await this.pool.query<StackVersionDbRow>(
      `UPDATE stack_versions
          SET status = CASE WHEN build_id IS NULL AND layout = 'builds' THEN 'failed' ELSE
                        CASE WHEN layout = 'legacy' AND commit_sha IS NULL THEN 'failed' ELSE 'ready' END END,
              last_error = $1
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
              tested_invalidated_at = CASE WHEN tested AND commit_sha IS DISTINCT FROM $2
                THEN COALESCE(tested_invalidated_at, NOW()) ELSE tested_invalidated_at END,
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
    forBuild: string | null = null,
  ): Promise<StackVersionRecord | null> {
    return this.one(
      `UPDATE stack_versions
          SET tested = $2, tested_invalidated_at = NULL
        WHERE id = $1
          AND (NOT $2 OR (
            status = 'ready' AND commit_sha = $3::text AND (
              (layout = 'builds' AND build_id = $4::text)
              OR (layout = 'legacy' AND build_id IS NULL AND $4::text IS NULL)
            )
          ))
        RETURNING ${VERSION_COLUMNS}`,
      [id, tested, forCommit, forBuild],
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
    layout: row.layout === 'builds' ? 'builds' : 'legacy',
    buildId: row.build_id,
    previousBuildId: row.previous_build_id,
    contract: parseStackContract(row.contract),
    isDefault: row.is_default,
    tested: row.tested,
    testedInvalidatedAt: row.tested_invalidated_at,
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
