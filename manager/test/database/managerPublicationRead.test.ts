import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { readManagerPublication } from '../../src/domain/versions/readManagerPublication.js';
import { PostgresBundledShipmentRepository } from '../../src/domain/versions/PostgresBundledShipmentRepository.js';
import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

const port = Number(process.env.T04B_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't04b_test', connectionTimeoutMillis: 10000 };
const identity = { shipmentId: '11111111-1111-4111-8111-111111111111', commit: 'a'.repeat(40), digest: 'd'.repeat(64) };
describe('read-only manager publication admission before migrations', {
  skip: !Number.isInteger(port) || port < 1 || port > 65535, timeout: 60000,
}, () => {
  let admin: Pool; let pool: Pool; let schema: string;
  beforeEach(async () => {
    schema = `t04b_publication_read_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, options: `-c search_path=${schema} -c statement_timeout=10000` });
  });
  afterEach(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });
  async function migrate(through = '999') {
    const path = new URL('../../src/migrations/', import.meta.url);
    for (const name of (await readdir(path)).filter(name => name.endsWith('.sql') && name < through).sort()) await pool.query(await readFile(new URL(name, path), 'utf8'));
  }
  async function relations() { return (await pool.query('SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename')).rows; }

  it('recognizes an actually empty schema without creating a migration ledger or tables', async () => {
    assert.deepEqual(await readManagerPublication(pool, identity), { schema: 'fresh', revision: '0', buildId: null, receipt: null, pending: null });
    assert.deepEqual(await relations(), []);
  });
  it('reads the original main-v2 schema without build or publication columns and never migrates it', async () => {
    await migrate('013'); const before = await relations();
    assert.deepEqual(await readManagerPublication(pool, identity), { schema: 'pre-journal', revision: '0', buildId: null, receipt: null, pending: null });
    assert.deepEqual(await relations(), before);
    assert.equal((await pool.query("SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND column_name='publication_revision'")).rows[0].count, '0');
  });
  it('preserves a pre-journal build identity without inventing its publication history', async () => {
    await migrate('024'); await pool.query("UPDATE stack_versions SET layout='builds', build_id=$1 WHERE name='bundled'", [identity.commit]);
    const actual = await readManagerPublication(pool, identity);
    assert.equal(actual.schema, 'pre-journal'); assert.equal(actual.buildId, identity.commit); assert.equal(actual.revision, '0');
  });
  it('reports a registered request original revision alongside current B, without changing either', async () => {
    await migrate(); const shipments = new PostgresBundledShipmentRepository(pool, '/synthetic/bundled');
    const selected = await shipments.register(identity); const versions = new PostgresStackVersionRepository(pool);
    await versions.publish(selected.versionId, { buildId: 'b'.repeat(40), commitSha: 'b'.repeat(40), rootPath: '/synthetic/bundled', contract: ALLOCATION_CONTRACT });
    const actual = await readManagerPublication(pool, identity);
    assert.equal(actual.schema, 'journal'); assert.equal(actual.revision, '1');
    assert.deepEqual(actual.pending, { state: 'registered', expectedRevision: '0' });
    assert.deepEqual(await shipments.find(identity.shipmentId), selected);
  });
  it('refuses a journal identity mismatch instead of treating the same UUID as a fresh request', async () => {
    await migrate(); await new PostgresBundledShipmentRepository(pool, '/synthetic/bundled').register(identity);
    await assert.rejects(readManagerPublication(pool, { ...identity, digest: 'e'.repeat(64) }), /identity/i);
  });
  it('refuses a partial journal schema and an unrelated nonempty schema', async () => {
    await pool.query('CREATE TABLE unrelated (id integer)');
    await assert.rejects(readManagerPublication(pool, identity), /schema|verified/i);
    await pool.query('DROP TABLE unrelated'); await migrate('024');
    await pool.query('ALTER TABLE stack_versions ADD COLUMN publication_revision bigint NOT NULL DEFAULT 0');
    await assert.rejects(readManagerPublication(pool, identity), /schema|verified/i);
  });
  it('propagates unavailable catalogue reads, never inventing revision zero', async () => {
    const client = { query: async () => { throw new Error('synthetic database unavailable'); }, release: () => {} };
    await assert.rejects(readManagerPublication({ connect: async () => client } as unknown as Pool, identity), /unavailable/);
    assert.deepEqual(await relations(), []);
  });
});
