import type { Pool, PoolClient } from 'pg';
import { MIGRATION_LOCK_KEY } from '../Database.js';
import type { ManagerPublication } from './ManagerUpgrade.js';
import { validateBundledShipmentIdentity, type BundledShipmentIdentity } from './bundledShipmentPackage.js';

const UNVERIFIED = 'Manager publication schema or identity cannot be verified.';
const VERSION_FIELDS = ['id', 'name', 'git_ref', 'commit_sha', 'status', 'root_path', 'contract', 'is_default', 'tested', 'built_at', 'last_error', 'created_at'];
const JOURNAL_FIELDS = ['shipment_id', 'version_id', 'commit_sha', 'package_digest', 'state', 'expected_publication_revision', 'candidate_build_id', 'receipt_revision', 'published_at'];
const REVISION = /^(0|[1-9][0-9]{0,18})$/;
function revision(value: unknown): string {
  if (typeof value !== 'string' || !REVISION.test(value)) throw new Error(UNVERIFIED);
  return value;
}
function buildId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[a-f0-9]{7,40}(?:-r[1-9][0-9]*)?$/.test(value)) throw new Error(UNVERIFIED);
  return value;
}
interface PublicationRow {
  id: number; build_id: string | null; publication_revision: string;
  shipment_id: string | null; version_id: number | null; commit_sha: string | null; package_digest: string | null;
  state: string | null; expected_revision: string | null; candidate_build_id: string | null; receipt_revision: string | null; published_at: Date | null;
}
async function readUnderSchemaGuard(client: PoolClient, identity: BundledShipmentIdentity): Promise<ManagerPublication> {
  const tables = await client.query<{ name: string; columns: string[] }>(
    `SELECT c.relname AS name, array_agg(a.attname::text ORDER BY a.attname) AS columns
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
     WHERE n.nspname=current_schema() AND c.relkind IN ('r','p') GROUP BY c.relname`,
  );
  if (tables.rows.length === 0) return { schema: 'fresh', revision: '0', buildId: null, receipt: null, pending: null };
  const versions = tables.rows.find(table => table.name === 'stack_versions');
  const journal = tables.rows.find(table => table.name === 'bundled_shipments');
  if (!versions || !VERSION_FIELDS.every(field => versions.columns.includes(field))) throw new Error(UNVERIFIED);
  const hasRevision = versions.columns.includes('publication_revision');
  if (!hasRevision && !journal) {
    const rows = await client.query<{ id: number; build_id: string | null }>(
      "SELECT id, to_jsonb(v)->>'build_id' AS build_id FROM stack_versions v WHERE name='bundled'",
    );
    if (rows.rows.length !== 1 || !Number.isSafeInteger(rows.rows[0]!.id)) throw new Error(UNVERIFIED);
    return { schema: 'pre-journal', revision: '0', buildId: buildId(rows.rows[0]!.build_id), receipt: null, pending: null };
  }
  if (!hasRevision || !journal || !versions.columns.includes('build_id') || !JOURNAL_FIELDS.every(field => journal.columns.includes(field))) throw new Error(UNVERIFIED);
  const result = await client.query<PublicationRow>(
    `SELECT v.id, v.build_id, v.publication_revision::text,
      s.shipment_id, s.version_id, s.commit_sha, s.package_digest, s.state,
      s.expected_publication_revision::text AS expected_revision, s.candidate_build_id,
      s.receipt_revision::text, s.published_at
     FROM stack_versions v LEFT JOIN bundled_shipments s ON s.shipment_id=$1
     WHERE v.name='bundled'`, [identity.shipmentId],
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || !row || !Number.isSafeInteger(row.id) || row.id < 1) throw new Error(UNVERIFIED);
  const base: ManagerPublication = { schema: 'journal', revision: revision(row.publication_revision), buildId: buildId(row.build_id), receipt: null, pending: null };
  if (row.shipment_id === null) return base;
  if (row.version_id !== row.id || row.shipment_id !== identity.shipmentId || row.commit_sha !== identity.commit || row.package_digest !== identity.digest) throw new Error(UNVERIFIED);
  if (row.state === 'published') {
    const candidate = buildId(row.candidate_build_id);
    if (!candidate || !(row.published_at instanceof Date) || !Number.isFinite(row.published_at.getTime())) throw new Error(UNVERIFIED);
    return { ...base, receipt: { shipmentId: row.shipment_id, versionId: row.id, buildId: candidate,
      publicationRevision: revision(row.receipt_revision), publishedAt: new Date(row.published_at) } };
  }
  if (row.state !== 'registered' && row.state !== 'prepared' && row.state !== 'superseded') throw new Error(UNVERIFIED);
  return { ...base, pending: { state: row.state, expectedRevision: revision(row.expected_revision) } };
}

/** The new image can inspect the old schema before stopping the old API. No error is interpreted as an empty database. */
export async function readManagerPublication(pool: Pool, input: BundledShipmentIdentity): Promise<ManagerPublication> {
  const identity = validateBundledShipmentIdentity(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('SELECT pg_advisory_xact_lock_shared($1)', [MIGRATION_LOCK_KEY]);
    const result = await readUnderSchemaGuard(client, identity);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
