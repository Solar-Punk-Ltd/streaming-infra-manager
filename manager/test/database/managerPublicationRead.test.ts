/**
 * What the new image may read of an old schema before it stops the old api,
 * and what the migrations leave behind now that the shipment journal is gone.
 *
 * Runs against the disposable Postgres the database suite uses, in a schema of
 * its own. It never migrates anything it only meant to read.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { readManagerPublication } from '../../src/domain/versions/readManagerPublication.js';

const port = Number(process.env.T04B_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't04b_test', connectionTimeoutMillis: 10000 };

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
  async function columnCount(name: string): Promise<string> {
    const rows = await pool.query("SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND column_name=$1", [name]);
    return rows.rows[0].count;
  }

  it('recognizes an actually empty schema without creating a migration ledger or tables', async () => {
    assert.deepEqual(await readManagerPublication(pool), { schema: 'fresh' });
    assert.deepEqual(await relations(), []);
  });

  it('reads the original main-v2 schema without build or publication columns and never migrates it', async () => {
    await migrate('013'); const before = await relations();
    assert.deepEqual(await readManagerPublication(pool), { schema: 'pre-journal' });
    assert.deepEqual(await relations(), before);
    assert.equal(await columnCount('publication_revision'), '0');
  });

  it('reads a schema that has every migration as the current one', async () => {
    await migrate();
    assert.deepEqual(await readManagerPublication(pool), { schema: 'current' });
  });

  it('has no shipment journal after every migration, and keeps the publication revision', async () => {
    await migrate();

    const tables = (await relations()).map((row) => row.tablename);
    assert.equal(tables.includes('bundled_shipments'), false, 'the journal the deploy used to write is gone');
    assert.equal(await columnCount('publication_revision'), '1', 'the revision the version rows still advance is not');
    const triggers = await pool.query(
      "SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND NOT t.tgisinternal ORDER BY tgname",
    );
    const names = triggers.rows.map((row) => row.tgname);
    assert.equal(names.includes('stack_publication_revision'), true, 'and neither is the trigger that advances it');
    assert.equal(names.includes('bundled_shipment_identity'), false, 'the journal trigger went with its table');
  });

  it('still advances the publication revision of a version row after the journal was dropped', async () => {
    await migrate();

    await pool.query("UPDATE stack_versions SET build_id = $1, layout = 'builds' WHERE name = 'bundled'", ['a'.repeat(40)]);

    const rows = await pool.query("SELECT publication_revision::text AS revision FROM stack_versions WHERE name = 'bundled'");
    assert.equal(rows.rows[0].revision, '1');
  });

  it('refuses an unrelated nonempty schema rather than calling it a manager database', async () => {
    await pool.query('CREATE TABLE unrelated (id integer)');
    await assert.rejects(readManagerPublication(pool), /schema|verified/i);
  });

  it('propagates unavailable catalogue reads, never inventing an empty database', async () => {
    const client = { query: async () => { throw new Error('synthetic database unavailable'); }, release: () => {} };
    await assert.rejects(readManagerPublication({ connect: async () => client } as unknown as Pool), /unavailable/);
    assert.deepEqual(await relations(), []);
  });
});
