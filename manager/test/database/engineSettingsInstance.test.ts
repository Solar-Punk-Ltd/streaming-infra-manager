import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { ProfileRepository } from '../../src/domain/ProfileRepository.js';

const port = Number(process.env.T11_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't11_test', connectionTimeoutMillis: 5_000 };

describe('engine settings instance fences in isolated PostgreSQL', { skip: !Number.isInteger(port) || port < 1 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let profiles: ProfileRepository;
  let instanceId: string;

  beforeEach(async () => {
    schema = `t11_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, application_name: schema, options: `-c search_path=${schema} -c statement_timeout=5000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    }
    profiles = new ProfileRepository(pool);
    instanceId = randomUUID();
    await pool.query(`INSERT INTO profiles (name, port_slot, kind, status, stack_version_id, instance_id, intent_revision, engine_settings)
      VALUES ('observed', 1, 'streamer', 'RUNNING', 1, $1, 4, '{"HLS_FRAGMENT":"7"}')`, [instanceId]);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  async function replace() {
    await pool.query("DELETE FROM profiles WHERE name = 'observed'");
    await pool.query(`INSERT INTO profiles (name, port_slot, kind, status, stack_version_id, instance_id, intent_revision, engine_settings)
      VALUES ('observed', 1, 'streamer', 'ERROR', 1, $1, 80, '{"HLS_FRAGMENT":"6"}')`, [randomUUID()]);
    return profiles.findByName('observed');
  }

  it('refuses a changed instance in the atomic status claim', async () => {
    const replacement = await replace();
    assert.equal(await profiles.transitionStatus('observed', 'DEPLOYING', ['ERROR'], instanceId), null);
    assert.deepEqual(await profiles.findByName('observed'), replacement);
  });

  it('cannot claim a replacement committed while waiting for the old row lock', async () => {
    const writer = await pool.connect();
    let claim: Promise<unknown> | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query("SELECT name FROM profiles WHERE name = 'observed' FOR UPDATE");
      claim = profiles.transitionStatus('observed', 'DEPLOYING', ['RUNNING'], instanceId);
      const deadline = Date.now() + 2000;
      while (true) {
        const waiting = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [schema]);
        if (waiting.rowCount) break;
        assert.ok(Date.now() < deadline, 'claim must actually wait on the held row lock');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await writer.query("DELETE FROM profiles WHERE name = 'observed'");
      await writer.query(`INSERT INTO profiles (name, port_slot, kind, status, stack_version_id, instance_id)
        VALUES ('observed', 1, 'streamer', 'RUNNING', 1, $1)`, [randomUUID()]);
      await writer.query('COMMIT');
      assert.equal(await claim, null);
      assert.equal((await profiles.findByName('observed'))?.status, 'RUNNING');
    } finally { await writer.query('ROLLBACK'); writer.release(); await claim; }
  });

  it('cannot write settings to a replacement after admission', async () => {
    const replacement = await replace();
    assert.equal(await profiles.updateEngineSettings('observed', { HLS_FRAGMENT: '2' }, instanceId), null);
    assert.deepEqual(await profiles.findByName('observed'), replacement);
  });

  it('cannot restore a replacement status when cancelling the old reservation', async () => {
    const replacement = await replace();
    assert.equal(await profiles.markTerminal('observed', 'RUNNING', instanceId), null);
    assert.deepEqual(await profiles.findByName('observed'), replacement);
  });

  it('cannot supersede a replacement intent as the old operator action resumes', async () => {
    const replacement = await replace();
    assert.equal(await profiles.bumpIntent('observed', instanceId), null);
    assert.deepEqual(await profiles.findByName('observed'), replacement);
  });

  it('keeps the current instance claim, settings write, intent bump and cancellation available', async () => {
    const claimed = await profiles.transitionStatus('observed', 'DEPLOYING', ['RUNNING'], instanceId);
    assert.equal(claimed?.instance_id, instanceId);
    assert.equal(claimed?.status, 'DEPLOYING');
    assert.equal((await profiles.bumpIntent('observed', instanceId))?.intent_revision, 5);
    assert.deepEqual((await profiles.updateEngineSettings('observed', { HLS_FRAGMENT: '2' }, instanceId))?.engine_settings, { HLS_FRAGMENT: '2' });
    assert.equal((await profiles.markTerminal('observed', 'RUNNING', instanceId))?.status, 'RUNNING');
  });
});
