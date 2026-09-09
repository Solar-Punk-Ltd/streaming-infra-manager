import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { ProfileRepository, type EngineSettingsWriteOwner } from '../../src/domain/ProfileRepository.js';
import { PostgresBuildLedger } from '../../src/domain/versions/PostgresBuildLedger.js';
import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import { deployOwnerOf, type ClaimedDeploy } from '../../src/domain/versions/buildLedger.js';
import type { EngineSettings } from '@streaming-infra-manager/common';
import type { Profile } from '../../src/types/index.js';

const port = Number(process.env.T11_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't11_test', connectionTimeoutMillis: 5000 };

describe('engine settings writes own the exact active job in isolated PostgreSQL', {
  skip: !Number.isInteger(port) || port < 1 || port > 65535,
}, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let root: string;
  let profiles: ProfileRepository;
  let ledger: PostgresBuildLedger;
  let versions: PostgresStackVersionRepository;
  let claim: ClaimedDeploy;

  beforeEach(async () => {
    schema = `t11_job_${randomBytes(8).toString('hex')}`;
    root = await mkdtemp(join(tmpdir(), 't11-settings-job-'));
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 6, application_name: schema, options: `-c search_path=${schema} -c statement_timeout=5000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    profiles = new ProfileRepository(pool);
    versions = new PostgresStackVersionRepository(pool);
    ledger = new PostgresBuildLedger(pool, { mountedRootOf: async () => { throw new Error('No Docker observations in settings tests'); } }, root);
    await pool.query(`INSERT INTO profiles (name, kind, port_slot, status, stack_version_id, instance_id, engine_settings)
      VALUES ('observed', 'streamer', 1, 'RUNNING', 1, $1, '{"HLS_FRAGMENT":"7"}')`, [randomUUID()]);
    const initial = (await profiles.findByName('observed'))!;
    claim = (await ledger.claim('observed', ['RUNNING'], await versions.findById(1), ['srs'], { ...deployOwnerOf(initial), intent: 'advance' }))!;
    assert.ok(claim);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    if (root) await rm(root, { recursive: true, force: true });
  });

  const ownerOf = (job: ClaimedDeploy): EngineSettingsWriteOwner => ({ ...deployOwnerOf(job.profile), jobReferenceId: job.descriptor.referenceId! });
  const state = async () => (await pool.query("SELECT * FROM profiles WHERE name = 'observed'")).rows[0];
  const write = (owner = ownerOf(claim), settings: EngineSettings = { HLS_FRAGMENT: '2' }) =>
    profiles.updateEngineSettings('observed', settings, owner);

  async function blocked() {
    const deadline = Date.now() + 2500;
    while (true) {
      if ((await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [schema])).rowCount) return;
      assert.ok(Date.now() < deadline, 'settings write must actually wait for the owned profile lock');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  it('writes the winning job without advancing its intent again', async () => {
    const saved = (await write())!;
    assert.deepEqual(saved.engine_settings, { HLS_FRAGMENT: '2' });
    assert.equal(saved.intent_revision, claim.profile.intent_revision);
    assert.equal(saved.status, 'DEPLOYING');
    assert.equal((await state()).deploy_job_reference_id, claim.descriptor.referenceId);
  });

  for (const field of ['instanceId', 'intentRevision', 'configRevision', 'stackVersionId', 'jobReferenceId'] as const) {
    it(`refuses a mismatched ${field} without touching the winner`, async () => {
      const owner = ownerOf(claim);
      if (field === 'instanceId') owner.instanceId = randomUUID();
      else owner[field] += 1;
      const before = await state();
      assert.equal(await write(owner), null);
      assert.deepEqual(await state(), before);
    });
  }

  for (const status of ['RUNNING', 'STOPPED', 'ERROR']) {
    it(`refuses the same job after leaving DEPLOYING for ${status}`, async () => {
      await pool.query("UPDATE profiles SET status = $1 WHERE name = 'observed'", [status]);
      const before = await state();
      assert.equal(await write(), null);
      assert.deepEqual(await state(), before);
    });
  }

  it('refuses an old write after a real same-intent successor claim and preserves independent holds', async () => {
    const reset = (await ledger.cancelClaim(claim.profile, claim.descriptor.referenceId!, 'RUNNING'))!;
    const successor = (await ledger.claim('observed', ['RUNNING'], await versions.findById(1), ['srs'], { ...deployOwnerOf(reset), intent: 'preserve' }))!;
    await pool.query("INSERT INTO build_references (version_id, build_id, holder_kind, holder_id) VALUES (1, 'bundled', 'operation', 'independent')");
    const before = await state();
    const references = (await pool.query('SELECT * FROM build_references ORDER BY id')).rows;
    assert.equal(await write(), null);
    assert.equal(await ledger.cancelClaim(claim.profile, claim.descriptor.referenceId!, 'RUNNING'), null);
    assert.deepEqual(await state(), before);
    assert.deepEqual((await pool.query('SELECT * FROM build_references ORDER BY id')).rows, references);
    assert.notEqual(successor.descriptor.referenceId, claim.descriptor.referenceId);
    assert.equal(successor.profile.intent_revision, claim.profile.intent_revision);
  });

  for (const change of ['same-intent-job', 'replacement'] as const) {
    it(`rechecks ${change} ownership after waiting for the profile lock`, async () => {
      const writer = await pool.connect();
      let pending: Promise<Profile | null> | undefined;
      try {
        await writer.query('BEGIN');
        await writer.query("SELECT name FROM profiles WHERE name = 'observed' FOR UPDATE");
        pending = write();
        pending.catch(() => {});
        await blocked();
        if (change === 'replacement') {
          const instanceId = randomUUID();
          await writer.query("DELETE FROM profiles WHERE name = 'observed'");
          const job = (await writer.query("INSERT INTO build_references (version_id, build_id, holder_kind, holder_id, profile_instance_id, intent_revision) VALUES (1,'bundled','job','observed',$1,$2) RETURNING id", [instanceId, claim.profile.intent_revision])).rows[0].id;
          await writer.query(`INSERT INTO profiles (name, kind, port_slot, status, stack_version_id, instance_id, intent_revision, deploy_job_reference_id, engine_settings)
            VALUES ('observed','streamer',1,'DEPLOYING',1,$1,$2,$3,'{"HLS_FRAGMENT":"6"}')`, [instanceId, claim.profile.intent_revision, job]);
        } else {
          const job = (await writer.query("INSERT INTO build_references (version_id, build_id, holder_kind, holder_id, profile_instance_id, intent_revision) VALUES (1,'bundled','job','observed',$1,$2) RETURNING id", [claim.profile.instance_id, claim.profile.intent_revision])).rows[0].id;
          await writer.query("UPDATE profiles SET deploy_job_reference_id = $1 WHERE name = 'observed'", [job]);
        }
        const before = (await writer.query("SELECT * FROM profiles WHERE name = 'observed'")).rows[0];
        await writer.query('COMMIT');
        assert.equal(await pending, null);
        assert.deepEqual(await state(), before);
      } finally { await writer.query('ROLLBACK'); writer.release(); await pending?.catch(() => {}); }
    });
  }
});
