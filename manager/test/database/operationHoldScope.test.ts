import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { ProfileRepository } from '../../src/domain/ProfileRepository.js';
import { PostgresPortReservationRepository } from '../../src/domain/ports/PostgresPortReservationRepository.js';
import type { Profile } from '../../src/types/index.js';

const port = Number(process.env.T01_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't01_test', connectionTimeoutMillis: 10000 };
const table = [{ name: 'SRS_SRT_PORT', defaultPort: 10001, slotBase: 10001, protocol: 'udp' as const, service: 'srs' }];

describe('operation holds protect their deployment instance', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool, pool: Pool, schema: string;
  let profiles: ProfileRepository, ports: PostgresPortReservationRepository, profile: Profile;
  beforeEach(async () => {
    schema = `t01_hold_scope_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, options: `-c search_path=${schema} -c statement_timeout=10000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    profiles = new ProfileRepository(pool);
    ports = new PostgresPortReservationRepository(pool);
    profile = (await profiles.insertWithFreeSlot('scope-owner', 'streamer', 'RUNNING', { components: ['srs'] }, {
      stackVersionId: 1, slotCap: 10, daemonId: 'synthetic-daemon', table,
    }))!;
  });
  afterEach(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  const ownerships = ['same instance', 'other instance', 'replaced instance', 'historical', 'partial historical', 'resolved'] as const;
  for (const ownership of ownerships) {
    for (const boundary of ['preflight', 'port handover', 'owned removal'] as const) {
      it(`${boundary} respects ${ownership} ownership without resolving its hold`, async () => {
        const instance = ownership === 'historical' ? null : ownership === 'other instance' ? randomUUID() : profile.instance_id;
        const intent = ownership === 'historical' || ownership === 'partial historical' ? null : profile.intent_revision;
        const hold = (await pool.query<{ id: number }>(
          `INSERT INTO build_references (version_id, build_id, holder_kind, holder_id, services, profile_instance_id, intent_revision, resolved_at)
            VALUES (1,'synthetic-old','operation','synthetic-operation',ARRAY['srs'],$1,$2,CASE WHEN $3 THEN NOW() ELSE NULL END) RETURNING id`,
          [instance, intent, ownership === 'resolved'],
        )).rows[0]!.id;
        if (ownership === 'replaced instance') {
          await pool.query('UPDATE profiles SET instance_id = $1 WHERE name = $2', [randomUUID(), profile.name]);
          profile = (await profiles.findByName(profile.name))!;
        }
        const before = (await pool.query('SELECT * FROM build_references WHERE id = $1', [hold])).rows[0];
        const blocked = ['same instance', 'historical', 'partial historical'].includes(ownership);
        if (boundary === 'preflight') assert.equal(await ports.hasRemovalHold(profile.name), blocked);
        else if (boundary === 'port handover') {
          const old = (await ports.listByProfile(profile.name))[0]!;
          const next = { portVar: old.portVar, protocol: old.protocol, port: old.port + 1000, service: 'srs' };
          await ports.plan('synthetic-daemon', profile.name, [next], 'synthetic replacement');
          await profiles.transitionStatus(profile.name, 'DEPLOYING', ['RUNNING']);
          await ports.reconcile({ profileName: profile.name, daemonId: 'synthetic-daemon', services: ['srs'], planned: [next], bound: [next] });
          assert.equal((await ports.listByProfile(profile.name)).some(row => row.id === old.id), blocked);
        } else {
          const claim = (await profiles.claimRemoval(profile.name, profile.instance_id))!;
          let filesRemoved = false;
          const removing = profiles.completeRemoval(claim, async () => { filesRemoved = true; });
          if (blocked) {
            await assert.rejects(removing, /rollback|hold/i);
            assert.equal(filesRemoved, false);
            assert.ok(await profiles.findByName(profile.name));
          } else {
            assert.ok(await removing);
            assert.equal(filesRemoved, true);
            assert.equal(await profiles.findByName(profile.name), null);
          }
        }
        assert.deepEqual((await pool.query('SELECT * FROM build_references WHERE id = $1', [hold])).rows[0], before);
      });
    }
  }
});
