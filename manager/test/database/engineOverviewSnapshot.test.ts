import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { ProfileRepository } from '../../src/domain/ProfileRepository.js';

const port = Number(process.env.T11_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't11_test', connectionTimeoutMillis: 5_000 };

describe('coherent engine overview inputs in isolated PostgreSQL', { skip: !Number.isInteger(port) || port < 1 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let profiles: ProfileRepository;

  beforeEach(async () => {
    schema = `t11_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, options: `-c search_path=${schema} -c statement_timeout=5000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    }
    profiles = new ProfileRepository(pool);
    await pool.query(`INSERT INTO profiles (name, port_slot, kind, status, engine_config, engine_config_revision, intent_revision, engine_settings)
      VALUES ('observed', 1, 'streamer', 'RUNNING', 'synthetic config A', 3, 4, '{"HLS_FRAGMENT":"7"}')`);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it('returns the profile and raw config separately from one query, without attaching config to the public profile', async () => {
    let reads = 0;
    const counted = new ProfileRepository({ query: (text: string, values?: unknown[]) => {
      reads += 1;
      return pool.query(text, values);
    } } as unknown as Pool);
    const snapshot = (await counted.engineOverviewSnapshot('observed'))!;
    assert.equal(reads, 1);
    assert.equal(snapshot.profile.engine_config_revision, 3);
    assert.equal(snapshot.profile.intent_revision, 4);
    assert.equal(snapshot.profile.has_engine_config, true);
    assert.deepEqual(snapshot.profile.engine_settings, { HLS_FRAGMENT: '7' });
    assert.equal(snapshot.engineConfig, 'synthetic config A');
    assert.equal('engine_config' in snapshot.profile, false);
  });

  it('reads either committed revision as a whole while another transaction replaces the config', async () => {
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(`UPDATE profiles SET engine_config = 'synthetic config B', engine_config_revision = 5,
        intent_revision = 6, engine_settings = '{"HLS_FRAGMENT":"8"}' WHERE name = 'observed'`);
      const before = (await profiles.engineOverviewSnapshot('observed'))!;
      assert.equal(before.engineConfig, 'synthetic config A');
      assert.equal(before.profile.engine_config_revision, 3);
      await writer.query('COMMIT');
      const after = (await profiles.engineOverviewSnapshot('observed'))!;
      assert.equal(after.engineConfig, 'synthetic config B');
      assert.equal(after.profile.engine_config_revision, 5);
      assert.deepEqual(after.profile.engine_settings, { HLS_FRAGMENT: '8' });
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
  });

  it('cannot combine an earlier profile with a replacement committed immediately after its query', async () => {
    const instance = randomUUID();
    let reads = 0;
    const replacing = new ProfileRepository({ query: async (text: string, values?: unknown[]) => {
      const result = await pool.query(text, values);
      reads += 1;
      if (reads === 1) {
        await pool.query("DELETE FROM profiles WHERE name = 'observed'");
        await pool.query(`INSERT INTO profiles (name, port_slot, kind, status, instance_id, engine_config, engine_config_revision)
          VALUES ('observed', 1, 'streamer', 'RUNNING', $1, 'synthetic replacement', 8)`, [instance]);
      }
      return result;
    } } as unknown as Pool);
    const snapshot = (await replacing.engineOverviewSnapshot('observed'))!;
    assert.equal(reads, 1);
    assert.notEqual(snapshot.profile.instance_id, instance);
    assert.equal(snapshot.engineConfig, 'synthetic config A');
    const current = (await profiles.engineOverviewSnapshot('observed'))!;
    assert.equal(current.profile.instance_id, instance);
    assert.equal(current.engineConfig, 'synthetic replacement');
  });

  it('keeps absent deployments distinct from an existing deployment using the template', async () => {
    assert.equal(await profiles.engineOverviewSnapshot('missing'), null);
    await pool.query("UPDATE profiles SET engine_config = NULL WHERE name = 'observed'");
    const snapshot = (await profiles.engineOverviewSnapshot('observed'))!;
    assert.equal(snapshot.profile.has_engine_config, false);
    assert.equal(snapshot.engineConfig, null);
  });
});
