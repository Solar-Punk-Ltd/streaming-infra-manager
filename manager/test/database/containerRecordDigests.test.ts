/**
 * The digests a container record keeps, migration 038, against a real
 * PostgreSQL.
 *
 * `pnpm test:database` in manager/, or on its own with T11_TEST_PG_PORT set.
 *
 * A record is written by every successful deploy and read to tell which
 * settings a running copy is behind on. This shows the repository writes and
 * reads back the salt and the digests, that a later deploy replaces both, and
 * that a record an older manager wrote reads as one with no salt, which the
 * page takes as not known rather than as changed.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { buildContainerSnapshot } from '../../src/domain/containerKeysSpec.js';
import { ContainerRepository } from '../../src/domain/ContainerRepository.js';
import { settingDigest, unsetDigest } from '../../src/domain/settings/runningRecord.js';

const port = Number(process.env.T11_TEST_PG_PORT);
const connection = {
  host: '127.0.0.1',
  port,
  user: 'postgres',
  database: 't11_test',
  connectionTimeoutMillis: 10000,
};

const THIS_MIGRATION = '038_';
const KEYS = ['LOG_LEVEL', 'ADMIN_API_TOKEN'];

describe('the digests a container record keeps, in isolated PostgreSQL', {
  skip: !Number.isInteger(port) || port < 1 || port > 65535,
}, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let containers: ContainerRepository;

  async function migrate(target: Pool, range: { from?: string; until?: string } = {}): Promise<void> {
    const directory = new URL('../../src/migrations/', import.meta.url);
    const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
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

  beforeEach(async () => {
    schema = `t11_record_digests_${randomBytes(8).toString('hex')}`;
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

  it('writes the salt and the digests and reads them back, and a later deploy replaces both', async () => {
    await migrate(pool);
    await insertProfile('stage', 3);
    const first = buildContainerSnapshot('stream-uploader', { LOG_LEVEL: 'debug', ADMIN_API_TOKEN: 'one' }, { keys: KEYS });
    await containers.upsert('stage', first);
    const second = buildContainerSnapshot('stream-uploader', { LOG_LEVEL: 'info' }, { keys: KEYS });
    await containers.upsert('stage', second);

    const [row] = await containers.listForProfile('stage');

    assert.equal(row?.env_salt, second.envSalt);
    assert.deepEqual(row?.env_digests, {
      LOG_LEVEL: settingDigest(second.envSalt, 'LOG_LEVEL', 'info'),
      ADMIN_API_TOKEN: unsetDigest(second.envSalt, 'ADMIN_API_TOKEN'),
    });
    assert.deepEqual(row?.env, { LOG_LEVEL: 'info' });
  });

  it('reads a record written before the digests as one with no salt', async () => {
    await migrate(pool, { until: THIS_MIGRATION });
    await insertProfile('legacy', 4);
    await pool.query(
      `INSERT INTO containers (profile_name, service, env) VALUES ('legacy', 'srs', '{"SRS_SRT_PORT":"10041"}'::jsonb)`,
    );

    await migrate(pool, { from: THIS_MIGRATION });
    const [row] = await containers.listForProfile('legacy');

    assert.equal(row?.env_salt, null);
    assert.deepEqual(row?.env_digests, {});
    assert.deepEqual(row?.env, { SRS_SRT_PORT: '10041' });
  });
});
