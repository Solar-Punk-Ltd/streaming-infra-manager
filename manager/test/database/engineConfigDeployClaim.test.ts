import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { ProfileRepository } from '../../src/domain/ProfileRepository.js';
import { PostgresDeployAttemptRepository } from '../../src/domain/PostgresDeployAttemptRepository.js';
import { PostgresEngineConfigOperationRepository } from '../../src/domain/engineConfig/PostgresEngineConfigOperationRepository.js';
import { ownershipOf } from '../../src/domain/engineConfig/operations.js';
import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import { PostgresExecutionRootRepository } from '../../src/domain/versions/PostgresExecutionRootRepository.js';
import { BUILD_COMPLETE_MARKER, BUILD_MANIFEST_FILE } from '../../src/domain/versions/buildManifest.js';
import { buildDirFor } from '../../src/domain/versions/stackPaths.js';
import type { StackVersionRecord } from '../../src/domain/versions/StackVersionRepository.js';
import type { Profile } from '../../src/types/index.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

const port = Number(process.env.T01_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't01_test', connectionTimeoutMillis: 10000 };
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const contract = { ...ALLOCATION_CONTRACT, engineConfig: { ...ALLOCATION_CONTRACT.engineConfig, srs: true } };
const stampFormat = `YYYY-MM-DD"T"HH24:MI:SS.US"Z"`;

describe('atomic config operation and final deploy job in PostgreSQL', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let root: string;
  let profiles: ProfileRepository;
  let versions: PostgresStackVersionRepository;
  let operations: PostgresEngineConfigOperationRepository;
  let attempts: PostgresDeployAttemptRepository;
  let initial: Profile;
  let selected: StackVersionRecord;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 't01-config-claim-'));
    schema = `t01_config_claim_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 8, options: `-c search_path=${schema} -c statement_timeout=10000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    }
    profiles = new ProfileRepository(pool);
    versions = new PostgresStackVersionRepository(pool);
    operations = new PostgresEngineConfigOperationRepository(pool, root);
    attempts = new PostgresDeployAttemptRepository(pool);
    const version = await versions.insert({ name: 'operation-stack', gitRef: 'synthetic', rootPath: join(root, 'operation-stack') });
    for (const buildId of [A, B]) {
      const artifact = buildDirFor(root, version.name, buildId);
      await mkdir(artifact, { recursive: true });
      await writeFile(join(artifact, BUILD_MANIFEST_FILE), JSON.stringify({ buildId, commit: buildId, builtAt: '2026-01-01T00:00:00Z', toolchain: 'synthetic' }));
      await writeFile(join(artifact, BUILD_COMPLETE_MARKER), '');
    }
    selected = (await versions.publish(version.id, { buildId: A, commitSha: A, contract }))!;
    initial = (await profiles.insertWithFreeSlot('config-owner', 'streamer', 'RUNNING', { host: 'localhost', components: ['srs'] }, {
      stackVersionId: selected.id, slotCap: 10, daemonId: 'synthetic-daemon', table: ALLOCATION_CONTRACT.ports,
    }))!;
    await pool.query("UPDATE profiles SET engine_config = 'synthetic previous config'");
    initial = (await profiles.findByName(initial.name))!;
    await pool.query("INSERT INTO deploy_targets (alias, daemon_id, verified_at) VALUES ('localhost', 'synthetic-daemon', '2026-01-01 00:00:00.123456+00')");
    await pool.query("UPDATE reservation_inventory SET seeded_at = '2026-01-01 00:00:00.234567+00'");
    await pool.query("INSERT INTO reservation_daemon_inventory (daemon_id, seeded_at) VALUES ('synthetic-daemon', '2026-01-01 00:00:00.345678+00')");
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function fixtureProof() {
    const target = (await pool.query(`SELECT daemon_id, to_char(verified_at AT TIME ZONE 'UTC', '${stampFormat}') AS verified_at FROM deploy_targets WHERE alias = 'localhost'`)).rows[0];
    const global = (await pool.query(`SELECT to_char(seeded_at AT TIME ZONE 'UTC', '${stampFormat}') AS seeded_at FROM reservation_inventory WHERE id = 1`)).rows[0];
    const daemon = (await pool.query(`SELECT to_char(seeded_at AT TIME ZONE 'UTC', '${stampFormat}') AS seeded_at FROM reservation_daemon_inventory WHERE daemon_id = 'synthetic-daemon'`)).rows[0];
    return { alias: 'localhost', daemonId: target.daemon_id as string, verifiedAt: target.verified_at as string,
      inventorySeededAt: global.seeded_at as string, daemonInventorySeededAt: daemon.seeded_at as string,
      snapshotToken: await attempts.captureSnapshotToken('synthetic-daemon', initial.name) };
  }

  async function request(profile = initial) {
    return { profile: structuredClone(profile), version: structuredClone(selected), engine: 'srs' as const,
      admission: await fixtureProof(), snapshot: { daemonId: 'synthetic-daemon', containerIds: ['synthetic-old-container'] } };
  }

  async function allRows() {
    return {
      profiles: (await pool.query('SELECT * FROM profiles ORDER BY name')).rows,
      operations: (await pool.query('SELECT * FROM engine_config_operations ORDER BY id')).rows,
      references: (await pool.query('SELECT * FROM build_references ORDER BY id')).rows,
      attempts: (await pool.query('SELECT * FROM deploy_attempts ORDER BY id')).rows,
      ports: (await pool.query('SELECT * FROM port_reservations ORDER BY id')).rows,
    };
  }

  it('captures the exact microsecond target and inventory generations before any snapshot read', async () => {
    const before = await allRows();
    const proof = await operations.captureDeployAdmission(initial);
    assert.deepEqual(proof, await fixtureProof());
    assert.equal(proof.verifiedAt, '2026-01-01T00:00:00.123456Z');
    assert.equal(proof.inventorySeededAt, '2026-01-01T00:00:00.234567Z');
    assert.equal(proof.daemonInventorySeededAt, '2026-01-01T00:00:00.345678Z');
    assert.deepEqual(await allRows(), before);
  });

  for (const kind of ['apply', 'reset'] as const) {
    it(`${kind} records the final config, operation, intent, job and attempt in one commit`, async () => {
      const config = kind === 'apply' ? 'synthetic new config' : null;
      const result = (await operations.beginDeploy({ ...await request(), kind, config }))!;
      assert.ok(result);
      assert.equal(result.profile.engine_config_revision, initial.engine_config_revision + 1);
      assert.equal(result.profile.intent_revision, initial.intent_revision + 1);
      assert.equal(result.profile.status, 'DEPLOYING');
      assert.equal(result.profile.deployment_phase, 'restarting');
      assert.equal(result.operation.previousConfig, 'synthetic previous config');
      assert.equal(result.operation.previousIsTemplate, false);
      assert.equal(result.operation.intentRevision, result.profile.intent_revision);
      assert.equal(result.operation.appliedRevision, result.profile.engine_config_revision);
      assert.equal(result.descriptor.buildId, A);
      const rows = await allRows();
      assert.equal(rows.profiles[0].engine_config, config);
      assert.equal(rows.profiles[0].deploy_job_reference_id, result.descriptor.referenceId);
      const jobs = rows.references.filter(reference => reference.holder_kind === 'job');
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].profile_instance_id, result.profile.instance_id);
      assert.equal(jobs[0].intent_revision, result.profile.intent_revision);
      assert.equal(rows.attempts.length, 1);
      assert.equal(rows.attempts[0].id, result.attempt.id);
      assert.deepEqual(rows.attempts[0].pre_job_container_ids, ['synthetic-old-container']);
      const executions = new PostgresExecutionRootRepository(pool, join(root, '.executions'));
      assert.ok(await executions.register({ executionId: randomUUID(),
        source: { versionId: selected.id, buildId: A, commit: A, root: result.descriptor.root, artifactDigest: 'd'.repeat(64) },
        profile: { name: initial.name, instanceId: result.profile.instance_id, intentRevision: result.profile.intent_revision, status: 'DEPLOYING' },
        jobReferenceId: result.descriptor.referenceId!, target: { alias: 'localhost', daemonId: 'synthetic-daemon' }, action: 'deploy', services: ['srs'] }));
    });
  }

  it('reads the previous bytes from the locked row rather than an earlier caller read', async () => {
    const input = await request();
    await pool.query("UPDATE profiles SET engine_config = 'synthetic latest locked config'");
    const result = (await operations.beginDeploy({ ...input, kind: 'apply', config: 'synthetic new config' }))!;
    assert.equal(result.operation.previousConfig, 'synthetic latest locked config');
  });

  for (const change of ['instance', 'intent', 'config', 'version', 'status', 'host', 'slot', 'engine'] as const) {
    it(`refuses a changed ${change} owner without partial writes`, async () => {
      const input = await request();
      if (change === 'instance') await pool.query('UPDATE profiles SET instance_id = $1', [randomUUID()]);
      if (change === 'intent') await pool.query('UPDATE profiles SET intent_revision = intent_revision + 1');
      if (change === 'config') await pool.query('UPDATE profiles SET engine_config_revision = engine_config_revision + 1');
      if (change === 'version') await pool.query("UPDATE profiles SET stack_version_id = (SELECT id FROM stack_versions WHERE name = 'bundled')");
      if (change === 'status') await pool.query("UPDATE profiles SET status = 'STOPPED'");
      if (change === 'host') await pool.query("UPDATE profiles SET host = 'other-target'");
      if (change === 'slot') await pool.query('UPDATE profiles SET port_slot = port_slot + 1');
      if (change === 'engine') await pool.query("UPDATE profiles SET components = ARRAY['ome']");
      const before = await allRows();
      assert.equal(await operations.beginDeploy({ ...input, kind: 'apply', config: 'synthetic new config' }), null);
      assert.deepEqual(await allRows(), before);
    });
  }

  for (const change of ['verification epoch', 'daemon', 'verification error', 'global seed', 'daemon seed', 'missing target', 'unseeded inventory', 'missing daemon inventory'] as const) {
    it(`refuses changed ${change} evidence before config, job or guard writes`, async () => {
      const input = await request();
      if (change === 'verification epoch') await pool.query("UPDATE deploy_targets SET verified_at = verified_at + interval '1 microsecond'");
      if (change === 'daemon') await pool.query("UPDATE deploy_targets SET daemon_id = 'other-daemon'");
      if (change === 'verification error') await pool.query("UPDATE deploy_targets SET last_error = 'synthetic failed verification'");
      if (change === 'global seed') await pool.query("UPDATE reservation_inventory SET seeded_at = seeded_at + interval '1 microsecond'");
      if (change === 'daemon seed') await pool.query("UPDATE reservation_daemon_inventory SET seeded_at = seeded_at + interval '1 microsecond'");
      if (change === 'missing target') await pool.query('DELETE FROM deploy_targets');
      if (change === 'unseeded inventory') await pool.query('UPDATE reservation_inventory SET seeded_at = NULL');
      if (change === 'missing daemon inventory') await pool.query('DELETE FROM reservation_daemon_inventory');
      const before = await allRows();
      await assert.rejects(operations.beginDeploy({ ...input, kind: 'apply', config: 'synthetic new config' }), /target|inventory|verification/i);
      assert.deepEqual(await allRows(), before);
    });
  }

  it('refuses a missing snapshot token on the new atomic path', async () => {
    const input = await request();
    Reflect.deleteProperty(input.admission, 'snapshotToken');
    const before = await allRows();
    await assert.rejects(operations.beginDeploy({ ...input, kind: 'apply', config: 'synthetic new config' }), /snapshot|token/i);
    assert.deepEqual(await allRows(), before);
  });

  it('refuses an intervening open-and-resolved attempt without changing config or adding a job', async () => {
    const input = await request();
    const intervening = await attempts.open({ daemonId: 'synthetic-daemon', project: initial.name, jobId: 'synthetic-intervening', kind: 'fixed', services: ['srs'], preJobContainerIds: [] });
    await attempts.resolve(intervening.id, { state: 'released', reason: null });
    const before = await allRows();
    await assert.rejects(operations.beginDeploy({ ...input, kind: 'apply', config: 'synthetic new config' }), /snapshot|history|changed/i);
    assert.deepEqual(await allRows(), before);
  });

  it('refuses publication after selection without a partial config write', async () => {
    const input = await request();
    await versions.publish(selected.id, { buildId: B, commitSha: B, contract });
    const before = await allRows();
    await assert.rejects(operations.beginDeploy({ ...input, kind: 'apply', config: 'synthetic new config' }), /changed/i);
    assert.deepEqual(await allRows(), before);
  });

  it('refuses a conflicting port before storing the new config or operation', async () => {
    const input = await request();
    await pool.query("UPDATE port_reservations SET profile_name = 'synthetic-other-owner' WHERE id = (SELECT min(id) FROM port_reservations)");
    const before = await allRows();
    await assert.rejects(operations.beginDeploy({ ...input, kind: 'apply', config: 'synthetic new config' }), /holds/);
    assert.deepEqual(await allRows(), before);
  });

  it('refuses a snapshot observed from another daemon', async () => {
    const input = await request();
    input.snapshot.daemonId = 'other-daemon';
    const before = await allRows();
    await assert.rejects(operations.beginDeploy({ ...input, kind: 'apply', config: 'synthetic new config' }), /daemon|target/i);
    assert.deepEqual(await allRows(), before);
  });

  for (const table of ['engine_config_operations', 'build_references', 'deploy_attempts'] as const) {
    it(`rolls back all final writes when ${table} insertion fails`, async () => {
      const input = await request();
      await pool.query(`ALTER TABLE ${table} ADD CONSTRAINT reject_synthetic_insert CHECK (false)`);
      const before = await allRows();
      await assert.rejects(operations.beginDeploy({ ...input, kind: 'apply', config: 'synthetic new config' }), /reject_synthetic_insert/);
      assert.deepEqual(await allRows(), before);
    });
  }

  it('admits one of two simultaneous applies with one operation and final job', async () => {
    const input = await request();
    const result = await Promise.allSettled([
      operations.beginDeploy({ ...input, kind: 'apply', config: 'synthetic A config' }),
      operations.beginDeploy({ ...input, kind: 'apply', config: 'synthetic B config' }),
    ]);
    const wins = result.filter(row => row.status === 'fulfilled' && row.value !== null);
    assert.equal(wins.length, 1);
    const rows = await allRows();
    assert.equal(rows.operations.length, 1);
    assert.equal(rows.references.filter(reference => reference.holder_kind === 'job').length, 1);
    assert.equal(rows.attempts.length, 1);
    assert.equal(rows.profiles[0].intent_revision, initial.intent_revision + 1);
  });

  for (const previous of ['synthetic previous config', null]) {
    it(`revert claims a fresh final job with the restored ${previous === null ? 'template' : 'file'} revision`, async () => {
      await pool.query('UPDATE profiles SET engine_config = $1', [previous]);
      const applied = (await operations.beginDeploy({ ...await request(), kind: 'apply', config: 'synthetic new config' }))!;
      await attempts.resolve(applied.attempt.id, { state: 'released', reason: null });
      await profiles.markTerminal(initial.name, 'RUNNING');
      await operations.transition(ownershipOf(applied.operation), ['applying'], 'watching');
      const current = (await profiles.findByName(initial.name))!;
      const reverted = (await operations.beginRevertDeploy({ ...await request(current), ownership: ownershipOf(applied.operation), message: 'synthetic failed watch' }))!;
      assert.equal(reverted.profile.intent_revision, applied.profile.intent_revision);
      assert.equal(reverted.profile.engine_config_revision, applied.profile.engine_config_revision + 1);
      assert.equal(reverted.operation.state, 'reverting');
      assert.equal(reverted.operation.appliedRevision, reverted.profile.engine_config_revision);
      assert.notEqual(reverted.descriptor.referenceId, applied.descriptor.referenceId);
      const rows = await allRows();
      assert.equal(rows.profiles[0].engine_config, previous);
      const jobs = rows.references.filter(reference => reference.holder_kind === 'job');
      assert.equal(jobs.length, 2);
      assert.equal(jobs[0].resolved_at, null);
      assert.equal(jobs[1].intent_revision, reverted.profile.intent_revision);
      assert.equal(rows.profiles[0].deploy_job_reference_id, reverted.descriptor.referenceId);
    });
  }

  it('a guard acquired after recovery preparation refuses before restoring the previous file', async () => {
    const applied = (await operations.beginDeploy({ ...await request(), kind: 'apply', config: 'synthetic new config' }))!;
    await attempts.resolve(applied.attempt.id, { state: 'released', reason: null });
    await profiles.markError(initial.name, 'synthetic recreate failure');
    const input = await request((await profiles.findByName(initial.name))!);
    const intervening = await attempts.open({ daemonId: 'synthetic-daemon', project: initial.name, jobId: 'synthetic-blocked', kind: 'fixed', services: ['srs'], preJobContainerIds: [] });
    await attempts.resolve(intervening.id, { state: 'blocked', reason: 'synthetic unchanged containers' });
    const before = await allRows();
    await assert.rejects(operations.beginRevertDeploy({ ...input, ownership: ownershipOf(applied.operation), message: 'synthetic recovery' }), /unresolved|blocked|attempt/i);
    assert.deepEqual(await allRows(), before);
    assert.equal((await allRows()).profiles[0].engine_config, 'synthetic new config');
  });
});
