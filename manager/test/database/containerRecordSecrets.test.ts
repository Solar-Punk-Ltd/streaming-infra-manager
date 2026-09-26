/**
 * Migration 036 against a real PostgreSQL: the container records written before
 * it lose their secrets and keep everything else.
 *
 * `pnpm test:database` in manager/, or on its own with T04B_TEST_PG_PORT set.
 *
 * A data fix only happens to rows that were there before it ran, which a unit
 * test cannot hold. This file runs the migrations into a schema of its own,
 * stops before 036, writes the records an older manager wrote, and then applies
 * the rest, the way an upgrade of the live manager applies them.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { NAMED_SECRET_SETTING_KEYS } from '@streaming-infra-manager/common';

import { ContainerRepository } from '../../src/domain/ContainerRepository.js';

const port = Number(process.env.T04B_TEST_PG_PORT);
const connection = {
  host: '127.0.0.1',
  port,
  user: 'postgres',
  database: 't04b_test',
  connectionTimeoutMillis: 10000,
};

const THIS_MIGRATION = '036_';

describe('the container records migration 036 scrubs, in isolated PostgreSQL', {
  skip: !Number.isInteger(port) || port < 1 || port > 65535,
}, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let containers: ContainerRepository;

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

  async function insertProfile(name: string, slot: number): Promise<void> {
    await pool.query(
      `INSERT INTO profiles (name, port_slot, kind, stack_version_id)
       VALUES ($1, $2, 'custom', (SELECT id FROM stack_versions WHERE name = 'bundled'))`,
      [name, slot],
    );
  }

  async function insertRecord(profile: string, service: string, env: Record<string, string>): Promise<void> {
    await pool.query(
      `INSERT INTO containers (profile_name, service, env) VALUES ($1, $2, $3::jsonb)`,
      [profile, service, JSON.stringify(env)],
    );
  }

  async function recordedEnv(profile: string, service: string): Promise<Record<string, string>> {
    const rows = await containers.listForProfile(profile);
    const row = rows.find((candidate) => candidate.service === service);
    assert.ok(row, `${profile} has a ${service} record`);
    return row.env;
  }

  beforeEach(async () => {
    schema = `t04b_container_secrets_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 4, options: `-c search_path=${schema}` });
    containers = new ContainerRepository(pool);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('takes every named secret out of a record and leaves the rest as it was', async () => {
    await migrate(pool, { until: THIS_MIGRATION });
    await insertProfile('legacy', 7);
    const secrets = Object.fromEntries(NAMED_SECRET_SETTING_KEYS.map((key) => [key, 'synthetic-secret']));
    await insertRecord('legacy', 'stream-uploader', { ...secrets, STAMP: 'cafe', API_PORT: '10070' });

    await migrate(pool, { from: THIS_MIGRATION });

    assert.deepEqual(await recordedEnv('legacy', 'stream-uploader'), { STAMP: 'cafe', API_PORT: '10070' });
  });

  it('takes out a secret the list does not name when its name has a secret ending', async () => {
    await migrate(pool, { until: THIS_MIGRATION });
    await insertProfile('suffixed', 8);
    await insertRecord('suffixed', 'srs', { SOME_VENDOR_PASSWORD: 'synthetic', SRS_SRT_PORT: '10180' });

    await migrate(pool, { from: THIS_MIGRATION });

    assert.deepEqual(await recordedEnv('suffixed', 'srs'), { SRS_SRT_PORT: '10180' });
  });

  it('leaves a record that holds no secret untouched, update time included', async () => {
    await migrate(pool, { until: THIS_MIGRATION });
    await insertProfile('clean', 9);
    await insertRecord('clean', 'bee-uploader', { BEE_UPLOADER_API_PORT: '10093', KEYSTORE_DIR: '/data' });
    const before = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM containers WHERE profile_name = 'clean'`,
    );

    await migrate(pool, { from: THIS_MIGRATION });

    const after = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM containers WHERE profile_name = 'clean'`,
    );
    assert.deepEqual(await recordedEnv('clean', 'bee-uploader'), {
      BEE_UPLOADER_API_PORT: '10093',
      KEYSTORE_DIR: '/data',
    });
    assert.deepEqual(after.rows[0]?.updated_at, before.rows[0]?.updated_at);
  });
});
