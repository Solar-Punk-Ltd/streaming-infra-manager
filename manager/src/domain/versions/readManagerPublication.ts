import type { Pool, PoolClient } from 'pg';
import { MIGRATION_LOCK_KEY } from '../Database.js';
import type { ManagerPublication } from './ManagerUpgrade.js';

const UNVERIFIED = 'Manager publication schema or identity cannot be verified.';
const VERSION_FIELDS = ['id', 'name', 'git_ref', 'commit_sha', 'status', 'root_path', 'contract', 'is_default', 'tested', 'built_at', 'last_error', 'created_at'];

/**
 * How much of the manager's schema this database has, decided from the tables
 * themselves rather than from the migration journal, because the schema may be
 * older than the code reading it.
 */
async function readUnderSchemaGuard(client: PoolClient): Promise<ManagerPublication> {
  const tables = await client.query<{ name: string; columns: string[] }>(
    `SELECT c.relname AS name, array_agg(a.attname::text ORDER BY a.attname) AS columns
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
     WHERE n.nspname=current_schema() AND c.relkind IN ('r','p') GROUP BY c.relname`,
  );
  if (tables.rows.length === 0) return { schema: 'fresh' };
  const versions = tables.rows.find(table => table.name === 'stack_versions');
  if (!versions || !VERSION_FIELDS.every(field => versions.columns.includes(field))) throw new Error(UNVERIFIED);
  if (!versions.columns.includes('publication_revision')) return { schema: 'pre-journal' };
  if (!versions.columns.includes('build_id')) throw new Error(UNVERIFIED);
  return { schema: 'current' };
}

/** The new image can inspect the old schema before stopping the old API. No error is interpreted as an empty database. */
export async function readManagerPublication(pool: Pool): Promise<ManagerPublication> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('SELECT pg_advisory_xact_lock_shared($1)', [MIGRATION_LOCK_KEY]);
    const result = await readUnderSchemaGuard(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
