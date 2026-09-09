import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { PostgresPortReservationRepository } from '../../src/domain/ports/PostgresPortReservationRepository.js';
import * as reservationSql from '../../src/domain/ports/reservationSql.js';

const port = Number(process.env.T01_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't01_test', connectionTimeoutMillis: 10000 };
const oldPort = { protocol: 'tcp' as const, port: 12000, portVar: 'SYNTHETIC_OLD', service: 'srs' };
const newPort = { protocol: 'tcp' as const, port: 12001, portVar: 'SYNTHETIC_NEW', service: 'srs' };

describe('port planning inside a caller-owned rollout transaction', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let ports: PostgresPortReservationRepository;

  beforeEach(async () => {
    schema = `t01_port_transaction_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 5, options: `-c search_path=${schema} -c statement_timeout=10000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    }
    ports = new PostgresPortReservationRepository(pool);
    await ports.plan('synthetic-daemon', 'owned', [oldPort], 'synthetic existing reservation');
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  async function rows() { return (await pool.query('SELECT * FROM port_reservations ORDER BY id')).rows; }

  it('rolls back new ports and changed service ownership together with the caller', async () => {
    const before = await rows();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await reservationSql.planPortReservations(client, 'synthetic-daemon', 'owned', [{ ...oldPort, service: 'ome' }, newPort], 'synthetic rollout');
      const pending = await client.query('SELECT port, held_services FROM port_reservations ORDER BY port');
      assert.deepEqual(pending.rows, [{ port: 12000, held_services: ['srs', 'ome'] }, { port: 12001, held_services: ['srs'] }]);
      await client.query('ROLLBACK');
    } finally { await client.query('ROLLBACK'); client.release(); }
    assert.deepEqual(await rows(), before);
    assert.equal((await ports.plan('synthetic-daemon', 'owned', [newPort], 'synthetic retry')).length, 1);
  });

  it('commits the exact same plan through the shared caller-owned primitive', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await reservationSql.planPortReservations(client, 'synthetic-daemon', 'owned', [oldPort, newPort], 'synthetic rollout');
      assert.deepEqual(inserted.map(row => row.port), [12001]);
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
    assert.deepEqual((await rows()).map(row => row.port), [12000, 12001]);
  });

  it('the existing public plan still refuses another owner without a partial new reservation', async () => {
    const before = await rows();
    await assert.rejects(ports.plan('synthetic-daemon', 'other', [newPort, oldPort], 'synthetic conflicting request'), /owned holds/);
    assert.deepEqual(await rows(), before);
  });
});
