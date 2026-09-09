import {
  BUNDLED_VERSION_NAME,
  parseStackContract,
  type StackContract,
} from '@streaming-infra-manager/common';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { StackVersionInUseError } from '../errors/StackVersionInUseError.js';
import { StackVersionRemovalHeldError } from '../errors/StackVersionRemovalHeldError.js';
import { assertVersionRemovable } from './versionRemovalGuard.js';
import { versionRemovalProblem } from './versionRemovalMarker.js';

import { STACK_PUBLICATION_ASSIGNMENTS } from './stackPublicationSql.js';

import type {
  BuildOutcome,
  LegacyMetadata,
  LegacyMetadataSnapshot,
  NewStackVersion,
  PublishOutcome,
  StackVersionRecord,
  StackVersionRepository,
  StackVersionUsage,
} from './StackVersionRepository.js';

const VERSION_COLUMNS = `
  id, name, git_ref, commit_sha, status, root_path, layout, build_id, previous_build_id, contract,
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
  layout: string;
  build_id: string | null;
  previous_build_id: string | null;
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
    const captured = structuredClone(version);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<StackVersionDbRow>(
        `INSERT INTO stack_versions (name, git_ref, root_path, status)
         VALUES ($1, $2, $3, 'building') RETURNING ${VERSION_COLUMNS}`,
        [captured.name, captured.gitRef, captured.rootPath],
      );
      const inserted = toRecord(result.rows[0]!);
      if (versionRemovalProblem(inserted)) throw new StackVersionRemovalHeldError(inserted.name, 'marker');
      await client.query('COMMIT');
      return inserted;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async markBuilding(id: number): Promise<StackVersionRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<StackVersionDbRow>(`SELECT ${VERSION_COLUMNS} FROM stack_versions WHERE id = $1 FOR UPDATE`, [id]);
      if (!locked.rows[0]) { await client.query('COMMIT'); return null; }
      const current = toRecord(locked.rows[0]);
      const problem = versionRemovalProblem(current);
      if (problem) throw new StackVersionRemovalHeldError(current.name, 'marker');
      const result = await client.query<StackVersionDbRow>(
        `UPDATE stack_versions SET status = 'building', last_error = NULL WHERE id = $1 RETURNING ${VERSION_COLUMNS}`, [id],
      );
      await client.query('COMMIT');
      return toRecord(result.rows[0]!);
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
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
              publication_revision = publication_revision + 1,
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
            SET ${STACK_PUBLICATION_ASSIGNMENTS}
          WHERE id = $1
          RETURNING ${VERSION_COLUMNS}`,
        [id, outcome.buildId, outcome.commitSha, JSON.stringify(outcome.contract), outcome.rootPath ?? null],
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
    await this.pool.query(
      'UPDATE stack_versions SET commit_sha = $2 WHERE id = $1',
      [id, commitSha],
    );
  }

  async captureLegacyMetadata(): Promise<LegacyMetadataSnapshot | null> {
    const result = await this.pool.query<StackVersionDbRow & { publication_revision: string }>(
      `SELECT ${VERSION_COLUMNS}, publication_revision FROM stack_versions WHERE name = $1 AND layout = 'legacy'`, [BUNDLED_VERSION_NAME],
    );
    const row = result.rows[0];
    return row ? { version: toRecord(row), publicationRevision: row.publication_revision } : null;
  }

  async refreshLegacyMetadata(expected: LegacyMetadataSnapshot, metadata: LegacyMetadata): Promise<boolean> {
    const selected = structuredClone({ expected, metadata });
    if (selected.expected.version.name !== BUNDLED_VERSION_NAME || selected.expected.version.layout !== 'legacy' ||
        typeof selected.expected.publicationRevision !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(selected.expected.publicationRevision) ||
        (selected.metadata.commitSha !== null && !/^[a-f0-9]{7,40}$/.test(selected.metadata.commitSha)) ||
        (selected.metadata.contract !== null && parseStackContract(selected.metadata.contract) === null)) throw new Error('Invalid legacy metadata snapshot.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<StackVersionDbRow & { publication_revision: string }>(
        `SELECT ${VERSION_COLUMNS}, publication_revision FROM stack_versions WHERE id = $1 FOR UPDATE`, [selected.expected.version.id],
      );
      const row = result.rows[0];
      if (!row || row.layout !== 'legacy' || row.publication_revision !== selected.expected.publicationRevision ||
          !isDeepStrictEqual(toRecord(row), selected.expected.version)) { await client.query('COMMIT'); return false; }
      const problem = versionRemovalProblem(selected.expected.version);
      if (problem) throw new Error(problem);
      await client.query('UPDATE stack_versions SET commit_sha = $2, contract = $3::jsonb WHERE id = $1',
        [row.id, selected.metadata.commitSha, JSON.stringify(selected.metadata.contract)]);
      await client.query('COMMIT');
      return true;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
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
  ): Promise<StackVersionRecord | null> {
    return this.one(
      `UPDATE stack_versions SET tested = $2 WHERE id = $1
       RETURNING ${VERSION_COLUMNS}`,
      [id, tested],
    );
  }

  async removeGuarded(expected: StackVersionRecord, removeOwnedFiles: (locked: StackVersionRecord) => Promise<void>): Promise<boolean> {
    const captured = structuredClone(expected);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<StackVersionDbRow>(`SELECT ${VERSION_COLUMNS} FROM stack_versions WHERE id = $1 FOR UPDATE`, [captured.id]);
      if (!result.rows[0]) { await client.query('COMMIT'); return false; }
      const current = toRecord(result.rows[0]);
      assertVersionRemovable(captured, current);
      const deployments = await client.query<{ name: string }>('SELECT name FROM profiles WHERE stack_version_id = $1 ORDER BY name', [current.id]);
      if (deployments.rows.length) throw new StackVersionInUseError(current.name, deployments.rows.map(row => row.name));
      const references = await client.query('SELECT 1 FROM build_references WHERE version_id = $1 AND resolved_at IS NULL LIMIT 1', [current.id]);
      if (references.rowCount) throw new StackVersionRemovalHeldError(current.name, 'references');
      // Terminal shipment receipts are immutable and their version FK is RESTRICT.
      const shipments = await client.query('SELECT 1 FROM bundled_shipments WHERE version_id = $1 LIMIT 1', [current.id]);
      if (shipments.rowCount) throw new StackVersionRemovalHeldError(current.name, 'shipments');
      const executions = await client.query("SELECT 1 FROM execution_roots WHERE version_id = $1 AND state <> 'released' LIMIT 1", [current.id]);
      if (executions.rowCount) throw new StackVersionRemovalHeldError(current.name, 'executions');
      await removeOwnedFiles(current);
      await client.query('DELETE FROM stack_versions WHERE id = $1', [current.id]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
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
