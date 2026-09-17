/**
 * The two columns T27 adds, against a real PostgreSQL.
 *
 * `pnpm test:database` in manager/, or on its own with T04B_TEST_PG_PORT set.
 *
 * A CHECK constraint and a backfill are the two things a unit test cannot
 * judge: the first only refuses inside the database, and the second only
 * happens to rows that were written before the migration ran. This file runs
 * the migrations into a schema of its own, once whole and once stopping before
 * 035, so both are exercised the way an upgrade of the live manager would
 * exercise them.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { ProfileRepository } from '../../src/domain/ProfileRepository.js';

const port = Number(process.env.T04B_TEST_PG_PORT);
const connection = {
  host: '127.0.0.1',
  port,
  user: 'postgres',
  database: 't04b_test',
  connectionTimeoutMillis: 10000,
};

const PLACEMENT = {
  stackVersionId: 1,
  slotCap: 99,
  daemonId: 'synthetic-daemon',
  table: [],
};

const ENDPOINT = 'https://rpc.example.org';

describe('the node mode and endpoint source columns in isolated PostgreSQL', {
  skip: !Number.isInteger(port) || port < 1 || port > 65535,
}, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let profiles: ProfileRepository;

  /** The migrations in order, all of them or the slice a test asks for. */
  async function migrate(
    target: Pool,
    range: { from?: string; until?: string } = {},
  ): Promise<void> {
    const directory = new URL('../../src/migrations/', import.meta.url);
    const names = (await readdir(directory))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    for (const name of names) {
      if (range.from && name < range.from) continue;
      if (range.until && name >= range.until) break;
      await target.query(await readFile(new URL(name, directory), 'utf8'));
    }
  }

  beforeEach(async () => {
    schema = `t04b_node_mode_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 4, options: `-c search_path=${schema}` });
    profiles = new ProfileRepository(pool);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('stores the stack and no mode for a deployment that names neither', async () => {
    await migrate(pool);

    const row = await profiles.insertWithFreeSlot('plain', 'custom', 'RUNNING', {}, PLACEMENT);

    assert.equal(row?.rpc_endpoint_source, 'stack');
    assert.equal(row?.node_mode, null);
  });

  it('stores a mode and a custom address, and reads both back', async () => {
    await migrate(pool);

    await profiles.insertWithFreeSlot('chosen', 'viewer', 'RUNNING', {
      node_mode: 'light',
      rpc_endpoint_source: 'custom',
      rpc_endpoint: ENDPOINT,
    }, PLACEMENT);
    const read = await profiles.findByName('chosen');

    assert.equal(read?.node_mode, 'light');
    assert.equal(read?.rpc_endpoint_source, 'custom');
    assert.equal(read?.rpc_endpoint, ENDPOINT);
  });

  it('refuses a custom source with no address', async () => {
    await migrate(pool);

    await assert.rejects(
      () => profiles.insertWithFreeSlot('half', 'custom', 'RUNNING', {
        rpc_endpoint_source: 'custom',
      }, PLACEMENT),
      /profiles_rpc_endpoint_source_pairing/,
    );
  });

  it('refuses an address beside a source that does not carry one', async () => {
    await migrate(pool);

    await assert.rejects(
      () => profiles.insertWithFreeSlot('both', 'custom', 'RUNNING', {
        rpc_endpoint_source: 'manager',
        rpc_endpoint: ENDPOINT,
      }, PLACEMENT),
      /profiles_rpc_endpoint_source_pairing/,
    );
  });

  it('refuses a mode the shared rule does not know', async () => {
    await migrate(pool);

    await assert.rejects(
      () => profiles.insertWithFreeSlot('odd', 'custom', 'RUNNING', {
        node_mode: 'full' as 'light',
      }, PLACEMENT),
      /node_mode/,
    );
  });

  it('keeps the stored mode through an update that says nothing about it', async () => {
    await migrate(pool);
    await profiles.insertWithFreeSlot('kept', 'custom', 'RUNNING', {
      node_mode: 'ultra-light',
      rpc_endpoint_source: 'custom',
      rpc_endpoint: ENDPOINT,
    }, PLACEMENT);

    const written = await profiles.updateEditable('kept', 'custom', { notes: 'edited' });

    // A node's mode is chosen when it is created, so an edit that never
    // mentions it cannot change it. The endpoint goes back to the stack's, the
    // way leaving out the address always has.
    assert.equal(written?.node_mode, 'ultra-light');
    assert.equal(written?.rpc_endpoint_source, 'stack');
    assert.equal(written?.rpc_endpoint, null);
  });

  it('reads a deployment that already named an address as a custom one', async () => {
    await migrate(pool, { until: '035_' });
    await pool.query(
      `INSERT INTO profiles (name, port_slot, kind, rpc_endpoint, stack_version_id)
       VALUES ('legacy', 7, 'custom', $1, (SELECT id FROM stack_versions WHERE name = 'bundled'))`,
      [ENDPOINT],
    );

    await migrate(pool, { from: '035_' });
    const read = await profiles.findByName('legacy');

    // It has always reached the chain through that address, so anything but
    // custom would move it somewhere else on its next deploy.
    assert.equal(read?.rpc_endpoint_source, 'custom');
    assert.equal(read?.rpc_endpoint, ENDPOINT);
    assert.equal(read?.node_mode, null);
  });
});
