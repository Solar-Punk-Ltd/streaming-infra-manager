import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { Database } from '../../src/domain/Database.js';

const port = Number(process.env.T04B_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't04b_test', connectionTimeoutMillis: 10000 };
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('migration admission did not finish')), 5000);
    })]);
  } finally { clearTimeout(timer!); }
}

describe('migration admission in isolated PostgreSQL', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool;
  let schema: string;
  let directory: string;
  let instances: { database: Database; name: string }[];
  beforeEach(async () => {
    schema = `t04b_migrate_${randomBytes(8).toString('hex')}`;
    directory = await mkdtemp(join(tmpdir(), 't04b-migrations-'));
    instances = [];
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
  });
  afterEach(async () => {
    for (const { database } of instances) await database.close();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  function database() {
    const name = `${schema}_${instances.length}`;
    const url = new URL(`postgresql://postgres@127.0.0.1:${port}/t04b_test`);
    url.searchParams.set('options', `-c search_path=${schema} -c statement_timeout=10000`);
    url.searchParams.set('application_name', name);
    const database = new Database(url.toString(), directory);
    instances.push({ database, name });
    return { database, name };
  }
  async function ledger() {
    return (await admin.query<{ name: string }>(`SELECT name FROM ${schema}._migrations ORDER BY name`)).rows.map(row => row.name);
  }
  async function waitForAdvisoryWait(name: string) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event = 'advisory'", [name]);
      if (result.rowCount) return;
      await delay(10);
    }
    throw new Error('migrator did not reach the expected advisory wait');
  }
  async function assertReleased() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const checkedOut = instances.some(({ database }) => database.pool.totalCount !== database.pool.idleCount || database.pool.waitingCount !== 0);
      const names = instances.map(instance => instance.name);
      const locks = await admin.query("SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.application_name = ANY($1::text[]) AND l.locktype = 'advisory'", [names]);
      if (!checkedOut && locks.rowCount === 0) return;
      await delay(10);
    }
    throw new Error('a checked-out client or migration advisory lock remained after completion');
  }

  it('serializes two fresh migrators before seen checks and applies each file once', async () => {
    const key = randomBytes(4).readUInt32BE() & 0x7fffffff;
    const blocker = await admin.connect();
    await blocker.query('SELECT pg_advisory_lock(42004, $1)', [key]);
    await writeFile(join(directory, '001_first.sql'), `SELECT pg_advisory_xact_lock(42004, ${key}); CREATE TABLE applied_once (value INTEGER); INSERT INTO applied_once VALUES (1);`);
    await writeFile(join(directory, '002_second.sql'), 'INSERT INTO applied_once VALUES (2);');
    const first = database();
    const second = database();
    const one = first.database.migrate().then(() => ({ error: null }), error => ({ error }));
    let two: typeof one | undefined;
    try {
      await waitForAdvisoryWait(first.name);
      two = second.database.migrate().then(() => ({ error: null }), error => ({ error }));
      await waitForAdvisoryWait(second.name);
    } finally {
      await blocker.query('SELECT pg_advisory_unlock(42004, $1)', [key]);
      blocker.release();
    }
    const outcomes = await bounded(Promise.all([one, two!]));
    assert.deepEqual(outcomes.map(outcome => outcome.error), [null, null]);
    assert.deepEqual(await ledger(), ['001_first.sql', '002_second.sql']);
    assert.deepEqual((await admin.query(`SELECT value FROM ${schema}.applied_once ORDER BY value`)).rows, [{ value: 1 }, { value: 2 }]);
    await assertReleased();
  });

  it('leaves an already-migrated repeat unchanged and releases admission', async () => {
    await writeFile(join(directory, '001_first.sql'), 'CREATE TABLE applied_once (value INTEGER); INSERT INTO applied_once VALUES (1);');
    const first = database();
    await first.database.migrate();
    const before = await admin.query(`SELECT * FROM ${schema}._migrations`);
    await bounded(database().database.migrate());
    assert.deepEqual((await admin.query(`SELECT * FROM ${schema}._migrations`)).rows, before.rows);
    assert.deepEqual((await admin.query(`SELECT value FROM ${schema}.applied_once`)).rows, [{ value: 1 }]);
    await assertReleased();
  });

  it('rolls back only the failed file, releases admission and permits a corrected retry', async () => {
    await writeFile(join(directory, '001_first.sql'), 'CREATE TABLE first_committed (value INTEGER);');
    await writeFile(join(directory, '002_second.sql'), 'CREATE TABLE must_rollback (value INTEGER); SELECT 1 / 0;');
    const first = database();
    await assert.rejects(first.database.migrate(), { code: '22012' });
    assert.deepEqual(await ledger(), ['001_first.sql']);
    assert.equal((await admin.query('SELECT to_regclass($1) AS found', [`${schema}.must_rollback`])).rows[0].found, null);
    assert.equal((await admin.query('SELECT to_regclass($1) AS found', [`${schema}.first_committed`])).rows[0].found, `${schema}.first_committed`);
    await assertReleased();
    await writeFile(join(directory, '002_second.sql'), 'CREATE TABLE must_rollback (value INTEGER);');
    await bounded(database().database.migrate());
    assert.deepEqual(await ledger(), ['001_first.sql', '002_second.sql']);
    await assertReleased();
  });

  it('preserves the original connection failure when rollback cannot run and discards the client', async () => {
    await writeFile(join(directory, '001_first.sql'), 'SELECT pg_terminate_backend(pg_backend_pid());');
    const first = database();
    await assert.rejects(first.database.migrate(), { code: '57P01' });
    await assertReleased();
    assert.equal(first.database.pool.totalCount, 0);
    await writeFile(join(directory, '001_first.sql'), 'CREATE TABLE retried (value INTEGER);');
    await bounded(first.database.migrate());
    assert.deepEqual(await ledger(), ['001_first.sql']);
    await assertReleased();
  });

  it('discards an unconfirmed unlock without reapplying a committed migration on retry', async () => {
    await writeFile(join(directory, '001_first.sql'), 'CREATE TABLE committed_once (value INTEGER); SELECT pg_advisory_unlock_all();');
    const first = database();
    await assert.rejects(first.database.migrate(), /migration.*lock/i);
    await assertReleased();
    assert.equal(first.database.pool.totalCount, 0);
    assert.deepEqual(await ledger(), ['001_first.sql']);
    await bounded(first.database.migrate());
    await assertReleased();
  });
});
