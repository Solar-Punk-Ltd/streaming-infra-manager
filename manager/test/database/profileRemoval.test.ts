import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool, type PoolClient } from 'pg';

import { ProfileRepository, type ProfileRemovalClaim } from '../../src/domain/ProfileRepository.js';
import { PostgresPortReservationRepository } from '../../src/domain/ports/PostgresPortReservationRepository.js';
import type { Profile } from '../../src/types/index.js';

const port = Number(process.env.T10_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't10_test', connectionTimeoutMillis: 10000 };
const placement = { stackVersionId: 1, slotCap: 100, daemonId: 'test-daemon', table: [
  { name: 'API_PORT', defaultPort: 10000, slotBase: 10000, protocol: 'tcp' as const, service: 'stream-uploader' },
] };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function untilBlocked(admin: Pool, blocked: number, blocker: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await admin.query<{ blocked: boolean }>('SELECT $2::integer = ANY(pg_blocking_pids($1)) AS blocked', [blocked, blocker]);
    if (result.rows[0]?.blocked) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected database operation did not wait for the ownership lock');
}

describe('instance-owned removal in isolated PostgreSQL', { skip: !Number.isInteger(port) || port < 1 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let profiles: ProfileRepository;
  let reservations: PostgresPortReservationRepository;
  const clients: PoolClient[] = [];

  beforeEach(async () => {
    schema = `t10_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 12, options: `-c search_path=${schema} -c statement_timeout=10000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    }
    profiles = new ProfileRepository(pool);
    reservations = new PostgresPortReservationRepository(pool);
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  async function insert(): Promise<Profile> {
    return (await profiles.insertWithFreeSlot('owned', 'viewer', 'RUNNING', {}, placement))!;
  }
  async function client(): Promise<PoolClient> {
    const value = await pool.connect();
    clients.push(value);
    return value;
  }
  async function pid(client: PoolClient): Promise<number> {
    return (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  }
  async function expectRetained(claim: ProfileRemovalClaim): Promise<void> {
    let cleaned = false;
    assert.equal(await profiles.completeRemoval(claim, async () => { cleaned = true; }), null);
    assert.equal(cleaned, false, 'stale completion must not touch name-owned files');
    assert.equal((await reservations.listByProfile('owned')).length, 1);
    assert.ok(await profiles.findByName('owned'));
  }

  it('refuses the old instance even when replacement commits while its claim waits', async () => {
    const original = await insert();
    const owner = await client();
    const waiter = await client();
    const [ownerPid, waiterPid] = await Promise.all([pid(owner), pid(waiter)]);
    await owner.query('BEGIN');
    await owner.query("UPDATE profiles SET instance_id = $1 WHERE name = 'owned'", [randomUUID()]);
    const pending = new ProfileRepository({ query: waiter.query.bind(waiter) } as unknown as Pool)
      .claimRemoval('owned', original.instance_id);
    await untilBlocked(admin, waiterPid, ownerPid);
    await owner.query('COMMIT');
    assert.equal(await pending, null);
    const replacement = (await profiles.findByName('owned'))!;
    assert.equal(replacement.status, 'RUNNING');
    assert.equal(replacement.intent_revision, original.intent_revision);
  });

  it('lets exactly one matching removal claim advance intent and returns the claimed row', async () => {
    const original = await insert();
    const claims = (await Promise.all(Array.from({ length: 8 }, () => profiles.claimRemoval('owned', original.instance_id)))).filter(Boolean);
    assert.equal(claims.length, 1);
    assert.equal(claims[0]!.instance_id, original.instance_id);
    assert.equal(claims[0]!.status, 'REMOVING');
    assert.equal(BigInt(claims[0]!.intent_revision), BigInt(original.intent_revision) + 1n);
  });

  for (const newer of ['instance', 'intent', 'status']) {
    it(`retains files, ports and replacement after ${newer} ownership changes`, async () => {
      const original = await insert();
      const claim = (await profiles.claimRemoval('owned', original.instance_id))!;
      if (newer === 'instance') await pool.query("UPDATE profiles SET instance_id = $1 WHERE name = 'owned'", [randomUUID()]);
      if (newer === 'intent') await pool.query("UPDATE profiles SET intent_revision = intent_revision + 1 WHERE name = 'owned'");
      if (newer === 'status') await pool.query("UPDATE profiles SET status = 'RUNNING' WHERE name = 'owned'");
      await expectRetained(claim);
      assert.equal(await profiles.failRemoval(claim, 'old script failed'), null);
      assert.equal((await profiles.findByName('owned'))!.last_error, null);
    });
  }

  it('holds canonical ownership until file cleanup and row release finish together', async () => {
    const original = await insert();
    const claim = (await profiles.claimRemoval('owned', original.instance_id))!;
    const entered = deferred();
    const release = deferred();
    const contender = await client();
    const contenderPid = await pid(contender);
    let completion: Promise<unknown> | undefined;
    let competing: Promise<unknown> | undefined;
    try {
      completion = profiles.completeRemoval(claim, async () => {
        assert.equal((await profiles.findByName('owned'))!.instance_id, original.instance_id);
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      competing = contender.query("UPDATE profiles SET intent_revision = intent_revision + 1 WHERE name = 'owned'");
      let blocked = false;
      for (let tick = 0; tick < 200; tick++) {
        const result = await admin.query<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [contenderPid]);
        if (result.rows[0]?.blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, 'new intent must wait while the owned files are removed');
    } finally {
      release.resolve();
      await completion;
      await competing;
    }
    assert.equal(await profiles.findByName('owned'), null);
    assert.deepEqual(await reservations.listByProfile('owned'), []);
    const replacement = await insert();
    assert.notEqual(replacement.instance_id, original.instance_id);
    await expectRetained(claim);
  });

  it('retains reservations when filesystem cleanup fails and permits only the owning failure write', async () => {
    const original = await insert();
    const claim = (await profiles.claimRemoval('owned', original.instance_id))!;
    await assert.rejects(profiles.completeRemoval(claim, async () => { throw new Error('synthetic file failure'); }), /synthetic file failure/);
    assert.equal((await profiles.findByName('owned'))!.status, 'REMOVING');
    assert.equal((await reservations.listByProfile('owned')).length, 1);
    assert.equal((await profiles.failRemoval(claim, 'synthetic file failure'))!.last_error, 'synthetic file failure');
    assert.equal(await profiles.failRemoval(claim, 'late duplicate'), null);
  });

  it('checks unresolved creation holds before filesystem cleanup', async () => {
    const original = await insert();
    const claim = (await profiles.claimRemoval('owned', original.instance_id))!;
    await pool.query("INSERT INTO deploy_attempts (daemon_id, project, job_id, kind) VALUES ('test-daemon', 'owned', 'blocked-test', 'fixed')");
    let cleaned = false;
    await assert.rejects(profiles.completeRemoval(claim, async () => { cleaned = true; }), /unresolved|attempt/);
    assert.equal(cleaned, false);
    assert.equal((await reservations.listByProfile('owned')).length, 1);
  });
});
