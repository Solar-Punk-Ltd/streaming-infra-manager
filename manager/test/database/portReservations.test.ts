import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { ProfileRepository } from '../../src/domain/ProfileRepository.js';
import { DeploymentGroupRepository, type SharedProfileParams } from '../../src/domain/DeploymentGroupRepository.js';
import { AllSlotsUsedError, PortReservedError } from '../../src/domain/errors/index.js';
import { PostgresPortReservationRepository } from '../../src/domain/ports/PostgresPortReservationRepository.js';
import type { StackPortVar } from '@streaming-infra-manager/common';

// The caller supplies only a port. The database and host cannot point at a deployed manager.
const port = Number(process.env.T06_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't06_test', connectionTimeoutMillis: 3000 };
const table: StackPortVar[] = [
  { name: 'API_PORT', defaultPort: 10000, slotBase: 10000, protocol: 'tcp', service: 'stream-uploader' },
  { name: 'SRS_SRT_PORT', defaultPort: 10001, slotBase: 10001, protocol: 'udp', service: 'srs' },
];
const entries = [
  { portVar: 'API_PORT', protocol: 'tcp' as const, port: 10010, service: 'stream-uploader' },
  { portVar: 'SRS_SRT_PORT', protocol: 'udp' as const, port: 10011, service: 'srs' },
];

describe('port reservations in isolated PostgreSQL schemas', { skip: !Number.isInteger(port) || port < 1 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let ports: PostgresPortReservationRepository;
  let profiles: ProfileRepository;

  beforeEach(async () => {
    schema = `t06_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 20, options: `-c search_path=${schema}` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    }
    ports = new PostgresPortReservationRepository(pool);
    profiles = new ProfileRepository(pool);
  });
  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('migrates from an empty schema and reads held ports with their owner', async () => {
    assert.equal(await ports.inventorySeededAt(), null);
    await ports.plan('daemon', 'a', entries, 'seed');
    const held = await ports.holdersOf('daemon', entries, 'b');
    assert.equal(held.length, 2);
    assert.ok(held.every((row) => row.profileName === 'a'));
  });

  it('makes concurrent seeding of the same profile idempotent', async () => {
    await Promise.all(Array.from({ length: 20 }, () => ports.plan('daemon', 'a', entries, 'seed')));
    assert.equal((await ports.listByProfile('a')).length, 2);
  });

  it('lets exactly one competing profile hold a port and names that owner to the others', async () => {
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, (_, n) => ports.plan('daemon', `p${n}`, entries, 'admission')));
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') assert.ok(outcome.reason instanceof PortReservedError);
    }
  });

  it('allocates concurrent profiles atomically without duplicate slots or port reservations', async () => {
    const rows = await Promise.all(Array.from({ length: 20 }, (_, n) =>
      profiles.insertWithFreeSlot(`p${n}`, 'viewer', 'DEPLOYING', {}, { stackVersionId: 1, slotCap: 100, daemonId: 'daemon', table })));
    assert.equal(new Set(rows.map((row) => row!.port_slot)).size, 20);
    assert.equal((await ports.listByDaemon('daemon')).length, 40);
  });

  it('rolls back the group, members and reservations when the whole group cannot fit', async () => {
    const shared: SharedProfileParams = {
      kind: 'viewer', notes: null, components: null, host: null,
      feed_owner: null, feed_topic: null, private_key: null, public_key: null, stamp_id: null, srt_passphrase: null,
      stack_version_id: 1, slot_cap: 1, daemon_id: 'daemon', table,
    };
    await assert.rejects(new DeploymentGroupRepository(pool).createGroupWithMembers('pool', 'standard',
      [{ name: 'a' }, { name: 'b' }], shared), AllSlotsUsedError);
    assert.equal((await profiles.list()).length, 0);
    assert.equal((await ports.listByDaemon('daemon')).length, 0);
    assert.equal((await pool.query('SELECT * FROM deployment_groups')).rowCount, 0);
  });
});
