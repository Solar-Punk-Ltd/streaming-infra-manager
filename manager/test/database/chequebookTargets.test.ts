import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool, type PoolClient } from 'pg';
import { PostgresChequebookOperationRepository } from '../../src/domain/chequebook/PostgresChequebookOperationRepository.js';
import { PostgresDeployAttemptRepository } from '../../src/domain/PostgresDeployAttemptRepository.js';
import { PROFILE_SLOT_LOCK_KEY } from '../../src/domain/profileSql.js';
import { operationCandidate, profileInstanceId } from '../support/chequebookOperations.js';

const port = Number(process.env.T09_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't09_test', connectionTimeoutMillis: 30000 };
const proof = {
  version: 1,
  profile: { name: 'test-deployment', instanceId: profileInstanceId, intentRevision: 0, engineConfigRevision: 0,
    kind: 'custom', components: ['bee-uploader'], host: null, portSlot: 1, stackVersionId: 1, status: 'RUNNING' },
  alias: 'localhost', daemonId: 'synthetic-daemon', verifiedAt: '2026-09-09T01:02:03.123456Z',
  reservation: { id: 1, protocol: 'tcp', port: 10015, service: 'bee-uploader', portVar: 'BEE_UPLOADER_API_PORT' },
};

describe('frozen money target ownership in isolated PostgreSQL schemas', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let repository: PostgresChequebookOperationRepository;
  beforeEach(async () => {
    schema = `t09_target_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 12, options: `-c search_path=${schema} -c statement_timeout=5000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    await pool.query(`INSERT INTO profiles (name, port_slot, instance_id, stack_version_id, status, components)
      VALUES ('test-deployment',1,$1,1,'RUNNING',ARRAY['bee-uploader'])`, [profileInstanceId]);
    await pool.query(`INSERT INTO deploy_targets (alias, daemon_id, verified_at) VALUES ('localhost','synthetic-daemon',$1)`, [proof.verifiedAt]);
    await pool.query(`INSERT INTO reservation_daemon_inventory (daemon_id) VALUES ('synthetic-daemon')`);
    await pool.query(`INSERT INTO port_reservations (daemon_id, protocol, port, profile_name, service, port_var, state, held_services)
      VALUES ('synthetic-daemon','tcp',10015,'test-deployment','bee-uploader','BEE_UPLOADER_API_PORT','active',ARRAY['bee-uploader'])`);
    repository = new PostgresChequebookOperationRepository(pool);
  });
  afterEach(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  function candidate() { return { ...operationCandidate(), submissionTarget: structuredClone(proof) }; }
  async function admitted() {
    const result = await repository.admit(candidate());
    assert.equal(result.kind, 'admitted');
    return result.operation;
  }
  async function assertNoDispatch(id: string) {
    assert.equal((await repository.claimDispatch(id)).claimed, false);
    assert.equal((await repository.findById(id))?.dispatchStartedAt, null);
  }
  async function waitForLockWait() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const blocked = await admin.query(`SELECT 1 FROM pg_stat_activity WHERE datname='t09_test'
        AND wait_event_type='Lock' AND query LIKE '%chequebook%'`);
      if (blocked.rows.length) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('The fixture did not reach the ownership lock.');
  }
  async function holdChange(sql: string, action: () => Promise<unknown>) {
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(sql);
      const result = action();
      // The SQL-specific tests below use a profile lock. The claim query is observable by its comment.
      await waitForLockWait();
      await writer.query('COMMIT');
      return await result;
    } finally { await writer.query('ROLLBACK'); writer.release(); }
  }

  it('retains an exact proof and gives only one concurrent dispatch permit without cached containers', async () => {
    const operation = await admitted();
    const row = (await pool.query('SELECT submission_target FROM chequebook_operations WHERE id=$1', [operation.id])).rows[0];
    assert.deepEqual(row.submission_target, proof);
    const claims = await Promise.all([repository.claimDispatch(operation.id), repository.claimDispatch(operation.id)]);
    assert.equal(claims.filter(claim => claim.claimed).length, 1);
    assert.equal((await pool.query('SELECT COUNT(*) FROM containers')).rows[0].count, '0');
  });

  it('refuses new admission without a proof and preserves exact replay after profile deletion', async () => {
    await assert.rejects(repository.admit(operationCandidate()), /target/i);
    const input = candidate();
    const result = await repository.admit(input);
    await pool.query('DELETE FROM profiles');
    assert.equal((await repository.admit({ ...input, submissionTarget: undefined })).kind, 'replayed');
    assert.equal((await repository.findWithResponses(result.operation.id))?.operation.id, result.operation.id);
  });

  it('keeps historical NULL proof readable but never authorizes dispatch', async () => {
    const operation = await admitted();
    await pool.query('UPDATE chequebook_operations SET submission_target=NULL WHERE id=$1', [operation.id]);
    await pool.query('DELETE FROM profiles');
    await assertNoDispatch(operation.id);
    assert.equal((await repository.recordSubmission(operation.id, { state: 'unknown', transactionHash: null, failureReason: 'response_unavailable' })).state, 'unknown');
  });

  const changes = [
    ['profile lifetime', `UPDATE profiles SET instance_id='22222222-2222-4222-8222-222222222222'`],
    ['operator intent', 'UPDATE profiles SET intent_revision=intent_revision+1'],
    ['deployment status', "UPDATE profiles SET status='DEPLOYING'"],
    ['active service', "UPDATE profiles SET components=ARRAY['stream-uploader']"],
    ['host alias', "UPDATE profiles SET host='other-alias'"],
    ['slot', 'UPDATE profiles SET port_slot=2'],
    ['alias invalidation', 'UPDATE deploy_targets SET verified_at=NULL'],
    ['alias verification epoch', "UPDATE deploy_targets SET verified_at=verified_at+INTERVAL '1 microsecond'"],
    ['daemon replacement', "UPDATE deploy_targets SET daemon_id='replacement-daemon'"],
    ['unseeded inventory', 'DELETE FROM reservation_daemon_inventory'],
    ['reservation release', "UPDATE port_reservations SET state='releasing'"],
    ['reservation reassignment', "UPDATE port_reservations SET profile_name='other-profile'"],
    ['reservation port', 'UPDATE port_reservations SET port=10025'],
    ['reservation service', "UPDATE port_reservations SET service='other-service'"],
    ['ambiguous held services', "UPDATE port_reservations SET held_services=ARRAY['bee-uploader','other-service']"],
    ['unowned held service', 'UPDATE port_reservations SET held_services=ARRAY[NULL]::text[]'],
    ['reservation replacement', `DELETE FROM port_reservations;
      INSERT INTO port_reservations (daemon_id,protocol,port,profile_name,service,port_var,state,held_services)
      VALUES ('synthetic-daemon','tcp',10015,'test-deployment','bee-uploader','BEE_UPLOADER_API_PORT','active',ARRAY['bee-uploader'])`],
    ['duplicate Bee API reservation', `INSERT INTO port_reservations (daemon_id,protocol,port,profile_name,service,port_var,state,held_services)
      VALUES ('synthetic-daemon','tcp',10025,'test-deployment','bee-uploader','BEE_UPLOADER_API_PORT','active',ARRAY['bee-uploader'])`],
  ];
  for (const [name, sql] of changes) {
    it(`refuses admission and dispatch after changed ${name}`, async () => {
      const input = candidate();
      const operation = await admitted();
      await pool.query(sql!);
      await assertNoDispatch(operation.id);
      await repository.recordSubmission(operation.id, { state: 'rejected', transactionHash: null, failureReason: 'preflight_failed' });
      await assert.rejects(repository.admit(input), /target|replaced/i);
      assert.equal(await repository.findByRequestId(input.requestId), null);
    });
  }

  it('refuses a project attempt opened after preparation and allows released and unrelated attempts', async () => {
    const operation = await admitted();
    const attempts = new PostgresDeployAttemptRepository(pool);
    const attempt = await attempts.open({ daemonId: proof.daemonId, project: proof.profile.name, jobId: randomUUID(), kind: 'fixed', services: ['bee-uploader'], preJobContainerIds: [] });
    await assertNoDispatch(operation.id);
    await attempts.release(attempt.id, 'synthetic-test');
    await attempts.open({ daemonId: proof.daemonId, project: 'unrelated', jobId: randomUUID(), kind: 'fixed', services: [], preJobContainerIds: [] });
    assert.equal((await repository.claimDispatch(operation.id)).claimed, true);
  });

  it('waits for an in-flight profile change before granting a dispatch permit', async () => {
    const operation = await admitted();
    const result = await holdChange('UPDATE profiles SET intent_revision=intent_revision+1', () => repository.claimDispatch(operation.id));
    assert.equal((result as { claimed: boolean }).claimed, false);
  });

  it('honors allocation and daemon attempt admission locks before the dispatch claim', async () => {
    const operation = await admitted();
    for (const [sql, params] of [
      ['SELECT pg_advisory_xact_lock($1)', [PROFILE_SLOT_LOCK_KEY]],
      ['SELECT pg_advisory_xact_lock(hashtext($1))', [`deploy-attempts:${proof.daemonId}`]],
    ] as const) {
      const writer: PoolClient = await pool.connect();
      try {
        await writer.query('BEGIN');
        await writer.query(sql, [...params]);
        let done = false;
        const claim = repository.claimDispatch(operation.id).then(value => { done = true; return value; });
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(done, false, 'claim must wait for the ownership writer');
        await writer.query("UPDATE profiles SET status='STOPPING'");
        await writer.query('COMMIT');
        assert.equal((await claim).claimed, false);
        await pool.query("UPDATE profiles SET status='RUNNING'");
      } finally { await writer.query('ROLLBACK'); writer.release(); }
    }
  });

  it('accepts a separately verified alias of the same daemon while refusing stale proof from the old alias', async () => {
    await pool.query("INSERT INTO deploy_targets (alias,daemon_id,verified_at) SELECT 'second-alias',daemon_id,verified_at FROM deploy_targets");
    await pool.query("UPDATE profiles SET host='second-alias'");
    await assert.rejects(repository.admit(candidate()), /target/i);
    const input = candidate();
    const alternate = { ...input.submissionTarget, alias: 'second-alias', profile: { ...input.submissionTarget.profile, host: 'second-alias' } };
    const admitted = await repository.admit({ ...input, submissionTarget: alternate });
    assert.equal((await repository.claimDispatch(admitted.operation.id)).claimed, true);
  });
});
