import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

const port = Number(process.env.T04B_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't04b_test', connectionTimeoutMillis: 10000 };
const A = 'a'.repeat(40); const B = 'b'.repeat(40);
function signal() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; }

describe('legacy metadata refresh cannot overwrite a publication', {
  skip: !Number.isInteger(port) || port < 1 || port > 65535, timeout: 60000,
}, () => {
  let admin: Pool; let pool: Pool; let schema: string; let versions: PostgresStackVersionRepository;
  beforeEach(async () => {
    schema = `t04b_legacy_refresh_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 5, options: `-c search_path=${schema} -c statement_timeout=10000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    versions = new PostgresStackVersionRepository(pool);
  });
  afterEach(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });
  async function stored() { return (await pool.query("SELECT * FROM stack_versions WHERE name = 'bundled'")).rows[0]; }

  it('initializes a still-legacy row in one update without claiming an artifact', async () => {
    const snapshot = (await versions.captureLegacyMetadata())!;
    assert.equal(await versions.refreshLegacyMetadata(snapshot, { commitSha: A, contract: ALLOCATION_CONTRACT }), true);
    const after = await stored();
    assert.equal(after.layout, 'legacy'); assert.equal(after.build_id, null); assert.equal(after.root_path, null);
    assert.equal(after.commit_sha, A); assert.deepEqual(after.contract, ALLOCATION_CONTRACT);
    assert.equal(after.publication_revision, '1');
  });

  it('refuses a refresh after publication B and leaves every B field unchanged', async () => {
    const snapshot = (await versions.captureLegacyMetadata())!;
    await versions.publish(snapshot.version.id, { buildId: B, commitSha: B, rootPath: '/synthetic/bundled', contract: ALLOCATION_CONTRACT });
    const before = await stored();
    assert.equal(await versions.refreshLegacyMetadata(snapshot, { commitSha: A, contract: null }), false);
    assert.deepEqual(await stored(), before);
    assert.equal(await versions.captureLegacyMetadata(), null);
  });

  it('refuses a competing changed refresh, including metadata changed back to the original value', async () => {
    const snapshot = (await versions.captureLegacyMetadata())!;
    assert.equal(await versions.refreshLegacyMetadata(snapshot, { commitSha: A, contract: null }), true);
    assert.equal(await versions.refreshLegacyMetadata(snapshot, { commitSha: B, contract: null }), false);
    await versions.setCommitSha(snapshot.version.id, null);
    const before = await stored();
    assert.equal(await versions.refreshLegacyMetadata(snapshot, { commitSha: B, contract: ALLOCATION_CONTRACT }), false);
    assert.deepEqual(await stored(), before);
  });

  it('rechecks after an actual version-row lock wait rather than trusting the earlier read', async () => {
    const snapshot = (await versions.captureLegacyMetadata())!;
    const writer = await pool.connect(); const entered = signal(); let readerPid = 0;
    const gatedPool = { query: pool.query.bind(pool), connect: async () => {
      const client = await pool.connect(); readerPid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      entered.resolve(); return client;
    } } as unknown as Pool;
    let refresh: Promise<boolean> | undefined;
    try {
      await writer.query('BEGIN'); await writer.query('SELECT id FROM stack_versions WHERE id = $1 FOR UPDATE', [snapshot.version.id]);
      refresh = new PostgresStackVersionRepository(gatedPool).refreshLegacyMetadata(snapshot, { commitSha: A, contract: null });
      await entered.promise;
      const deadline = performance.now() + 3000;
      while (!(await pool.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [readerPid])).rows[0].blocked) {
        assert.ok(performance.now() < deadline, 'refresh must actually wait for the version row');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await writer.query("UPDATE stack_versions SET layout='builds', build_id=$2, commit_sha=$2, root_path='/synthetic/bundled' WHERE id=$1", [snapshot.version.id, B]);
      await writer.query('COMMIT'); const before = await stored();
      assert.equal(await refresh, false); assert.deepEqual(await stored(), before);
    } finally { await writer.query('ROLLBACK'); writer.release(); await refresh?.catch(() => {}); }
  });

  it('freezes its expected identity before waiting for a pool connection', async () => {
    const snapshot = (await versions.captureLegacyMetadata())!;
    const entered = signal(); const release = signal();
    const gatedPool = { query: pool.query.bind(pool), connect: async () => { entered.resolve(); await release.promise; return pool.connect(); } } as unknown as Pool;
    const refresh = new PostgresStackVersionRepository(gatedPool).refreshLegacyMetadata(snapshot, { commitSha: B, contract: null });
    try {
      await entered.promise; await versions.setCommitSha(snapshot.version.id, A);
      snapshot.version.commitSha = A; snapshot.publicationRevision = '1';
      const before = await stored(); release.resolve();
      assert.equal(await refresh, false); assert.deepEqual(await stored(), before);
    } finally { release.resolve(); await refresh.catch(() => {}); }
  });
});
