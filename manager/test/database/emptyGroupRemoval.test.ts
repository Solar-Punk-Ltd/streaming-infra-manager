import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool, type PoolClient } from 'pg';

import { DeploymentGroupRepository } from '../../src/domain/DeploymentGroupRepository.js';
import { ProfileRepository } from '../../src/domain/ProfileRepository.js';

const port = Number(process.env.T10_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't10_test', connectionTimeoutMillis: 10000 };
const placement = { stackVersionId: 1, slotCap: 100, daemonId: 'test-daemon', table: [
  { name: 'API_PORT', defaultPort: 10000, slotBase: 10000, protocol: 'tcp' as const, service: 'stream-uploader' },
] };

async function waitForBlock(admin: Pool, blocker: number): Promise<void> {
  for (let tick = 0; tick < 200; tick++) {
    const result = await admin.query('SELECT 1 FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))', [blocker]);
    if (result.rowCount) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('The expected concurrent operation did not wait');
}

describe('empty group removal in isolated PostgreSQL', { skip: !Number.isInteger(port) || port < 1 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let groups: DeploymentGroupRepository;
  const clients: PoolClient[] = [];
  beforeEach(async () => {
    schema = `t10_groups_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 10, options: `-c search_path=${schema} -c statement_timeout=10000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    }
    groups = new DeploymentGroupRepository(pool);
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });
  async function group(name = 'owned'): Promise<number> {
    return (await pool.query<{ id: number }>("INSERT INTO deployment_groups (name, size, kind) VALUES ($1, 2, 'standard') RETURNING id", [name])).rows[0]!.id;
  }
  async function client() {
    const value = await pool.connect();
    clients.push(value);
    return value;
  }
  async function member(client: PoolClient, groupId: number): Promise<void> {
    await client.query("INSERT INTO profiles (name, kind, status, port_slot, stack_version_id, group_id) VALUES ('foreign', 'viewer', 'STOPPED', 1, 1, $1)", [groupId]);
  }

  it('removes only the unchanged empty group and treats the same removed ID as absent', async () => {
    const id = await group();
    assert.equal(await groups.removeEmptyGroup(id, 'owned'), 'deleted');
    const replacementId = await group();
    assert.notEqual(replacementId, id);
    assert.equal(await groups.removeEmptyGroup(id, 'owned'), 'absent');
    assert.ok(await groups.findById(replacementId));
  });

  it('retains an empty group whose name no longer matches the confirmed identity', async () => {
    const id = await group('replacement');
    assert.equal(await groups.removeEmptyGroup(id, 'owned'), 'changed');
    assert.ok(await groups.findById(id));
  });

  it('retains a foreign member and its group without resizing it during cleanup refusal', async () => {
    const id = await group();
    const profiles = new ProfileRepository(pool);
    const profile = await profiles.insertWithFreeSlot('foreign', 'viewer', 'STOPPED', { group_id: id }, placement);
    const before = await groups.findById(id);
    assert.equal(await groups.removeEmptyGroup(id, 'owned'), 'not_empty');
    assert.deepEqual(await profiles.findByName('foreign'), profile);
    assert.deepEqual(await groups.findById(id), before);
  });

  for (const mode of ['explicit', 'automatic'] as const) {
    it(`retains a concurrent foreign insert which commits while ${mode} cleanup waits for its parent`, async () => {
      const id = await group();
      const inserting = await client();
      const pid = (await inserting.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await inserting.query('BEGIN');
      await member(inserting, id);
      const removing = mode === 'explicit' ? groups.removeEmptyGroup(id, 'owned') : groups.syncMembershipAfterRemoval(id);
      try { await waitForBlock(admin, pid); }
      finally { await inserting.query('COMMIT'); }
      assert.equal(await removing, mode === 'explicit' ? 'not_empty' : 'resized');
      assert.ok(await groups.findById(id));
      assert.equal((await pool.query("SELECT group_id FROM profiles WHERE name = 'foreign'")).rows[0].group_id, id);
    });
  }

  it('serializes a late member insertion after deletion and rolls back its reservation', async () => {
    const id = await group();
    const blocker = await client();
    const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM deployment_groups WHERE id = $1 FOR UPDATE', [id]);
    const deleting = groups.removeEmptyGroup(id, 'owned');
    await waitForBlock(admin, pid);
    const adding = new ProfileRepository(pool).insertWithFreeSlot('late', 'viewer', 'STOPPED', { group_id: id }, placement);
    const outcome = adding.then(() => 'inserted', () => 'refused');
    await blocker.query('COMMIT');
    assert.equal(await deleting, 'deleted');
    assert.equal(await outcome, 'refused');
    assert.equal((await pool.query("SELECT * FROM profiles WHERE name = 'late'")).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM port_reservations WHERE profile_name = 'late'")).rowCount, 0);
  });
});
