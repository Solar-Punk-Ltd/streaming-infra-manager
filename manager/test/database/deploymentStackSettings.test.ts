/**
 * The per-deployment stack settings columns of migration 037, against a real
 * PostgreSQL.
 *
 * `pnpm test:database` in manager/, or on its own with T11_TEST_PG_PORT set.
 *
 * Two things only the database can show: that the deploy reads the plain and
 * the secret column as one set, and that neither column travels with a row,
 * which is what reaches every signed-in page and every event.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { ProfileRepository } from '../../src/domain/ProfileRepository.js';

const port = Number(process.env.T11_TEST_PG_PORT);
const connection = {
  host: '127.0.0.1',
  port,
  user: 'postgres',
  database: 't11_test',
  connectionTimeoutMillis: 10000,
};

const SECRET = 'synthetic-admin-token';

describe('the per-deployment stack settings columns, in isolated PostgreSQL', {
  skip: !Number.isInteger(port) || port < 1 || port > 65535,
}, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let profiles: ProfileRepository;

  async function migrate(target: Pool): Promise<void> {
    const directory = new URL('../../src/migrations/', import.meta.url);
    const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
    for (const name of names) {
      await target.query(await readFile(new URL(name, directory), 'utf8'));
    }
  }

  async function insertProfile(name: string, slot: number): Promise<void> {
    await pool.query(
      `INSERT INTO profiles (name, port_slot, kind, stack_version_id)
       VALUES ($1, $2, 'custom', (SELECT id FROM stack_versions WHERE name = 'bundled'))`,
      [name, slot],
    );
  }

  beforeEach(async () => {
    schema = `t11_stack_settings_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 4, options: `-c search_path=${schema}` });
    profiles = new ProfileRepository(pool);
    await migrate(pool);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('starts every deployment with nothing stored and at revision 0', async () => {
    await insertProfile('fresh', 3);

    const stored = await pool.query(
      `SELECT stack_settings, stack_settings_secret, settings_revision FROM profiles WHERE name = 'fresh'`,
    );

    assert.deepEqual(stored.rows[0], { stack_settings: {}, stack_settings_secret: {}, settings_revision: 0 });
    assert.deepEqual(await profiles.stackSettingsForDeploy('fresh'), {});
  });

  it('hands the deploy the plain and the secret values as one set', async () => {
    await insertProfile('stage', 4);
    await pool.query(
      `UPDATE profiles SET stack_settings = $1::jsonb, stack_settings_secret = $2::jsonb WHERE name = 'stage'`,
      [JSON.stringify({ LOG_LEVEL: 'debug', ADMIN_API_URL: '' }), JSON.stringify({ ADMIN_API_TOKEN: SECRET })],
    );

    assert.deepEqual(await profiles.stackSettingsForDeploy('stage'), {
      LOG_LEVEL: 'debug',
      ADMIN_API_URL: '',
      ADMIN_API_TOKEN: SECRET,
    });
  });

  it('keeps both columns off the row every page and event carries', async () => {
    await insertProfile('private', 5);
    await pool.query(
      `UPDATE profiles SET stack_settings_secret = $1::jsonb WHERE name = 'private'`,
      [JSON.stringify({ ADMIN_API_TOKEN: SECRET })],
    );

    const found = await profiles.findByName('private');
    const listed = (await profiles.list()).find((profile) => profile.name === 'private');

    for (const row of [found, listed]) {
      assert.ok(row);
      assert.equal('stack_settings' in row, false);
      assert.equal('stack_settings_secret' in row, false);
      assert.doesNotMatch(JSON.stringify(row), new RegExp(SECRET));
    }
  });

  it('refuses a value that is not a JSON object', async () => {
    await insertProfile('shape', 6);

    await assert.rejects(
      pool.query(`UPDATE profiles SET stack_settings = '["LOG_LEVEL"]'::jsonb WHERE name = 'shape'`),
      /check constraint/i,
    );
    await assert.rejects(
      pool.query(`UPDATE profiles SET stack_settings_secret = '"x"'::jsonb WHERE name = 'shape'`),
      /check constraint/i,
    );
  });
});
