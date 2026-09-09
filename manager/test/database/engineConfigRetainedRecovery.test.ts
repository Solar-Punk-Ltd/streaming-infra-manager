import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { EventBus } from '../../src/domain/EventBus.js';
import { ProfileRepository } from '../../src/domain/ProfileRepository.js';
import { PostgresDeployAttemptRepository } from '../../src/domain/PostgresDeployAttemptRepository.js';
import { PostgresEngineConfigOperationRepository } from '../../src/domain/engineConfig/PostgresEngineConfigOperationRepository.js';
import { captureRolloutRecovery } from '../../src/domain/engineConfig/rolloutRecoveryDescriptor.js';
import { ownershipOf } from '../../src/domain/engineConfig/operations.js';
import { PostgresBuildLedger } from '../../src/domain/versions/PostgresBuildLedger.js';
import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import { StackVersionService } from '../../src/domain/versions/StackVersionService.js';
import { BUILD_COMPLETE_MARKER, BUILD_MANIFEST_FILE } from '../../src/domain/versions/buildManifest.js';
import { deployOwnerOf } from '../../src/domain/versions/buildLedger.js';
import { buildDirFor } from '../../src/domain/versions/stackPaths.js';
import type { StackVersionRecord } from '../../src/domain/versions/StackVersionRepository.js';
import type { Profile } from '../../src/types/index.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

const port = Number(process.env.T01_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't01_test', connectionTimeoutMillis: 10000 };
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), D = 'd'.repeat(40);
const contract = { ...ALLOCATION_CONTRACT, engineConfig: { ...ALLOCATION_CONTRACT.engineConfig, srs: true } };
const observer = { mountedRootOf: async (): Promise<string | null> => { throw new Error('no Docker observation'); } };
const runner = { run: (): never => { throw new Error('no build'); } };
type Applied = NonNullable<Awaited<ReturnType<PostgresEngineConfigOperationRepository['beginDeploy']>>>;
function signal<T = void>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('retained recovery interleaving did not finish')), 5000); })]); }
  finally { clearTimeout(timer!); }
}

describe('retained rollout artifact recovery in PostgreSQL', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool, pool: Pool, schema: string, root: string;
  let profiles: ProfileRepository, versions: PostgresStackVersionRepository;
  let operations: PostgresEngineConfigOperationRepository, attempts: PostgresDeployAttemptRepository, ledger: PostgresBuildLedger;
  let initial: Profile, selected: StackVersionRecord;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 't01-retained-recovery-'));
    schema = `t01_retained_recovery_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 10, options: `-c search_path=${schema} -c statement_timeout=10000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    profiles = new ProfileRepository(pool);
    versions = new PostgresStackVersionRepository(pool);
    operations = new PostgresEngineConfigOperationRepository(pool, root);
    attempts = new PostgresDeployAttemptRepository(pool);
    ledger = new PostgresBuildLedger(pool, observer, root);
    const version = await versions.insert({ name: 'retained-stack', gitRef: 'synthetic', rootPath: join(root, 'retained-stack') });
    for (const id of [A, B, C, D, `${A}-r1`, `${A}-r2`]) await artifact(id, id.slice(0, 40));
    selected = (await versions.publish(version.id, { buildId: A, commitSha: A, contract }))!;
    initial = (await profiles.insertWithFreeSlot('retained-owner', 'streamer', 'RUNNING', { host: 'localhost', components: ['srs'] }, {
      stackVersionId: selected.id, slotCap: 10, daemonId: 'synthetic-daemon', table: ALLOCATION_CONTRACT.ports,
    }))!;
    await pool.query("UPDATE profiles SET engine_config = 'synthetic previous config'");
    initial = (await profiles.findByName(initial.name))!;
    await pool.query("INSERT INTO deploy_targets (alias, daemon_id, verified_at) VALUES ('localhost', 'synthetic-daemon', NOW())");
    await pool.query('UPDATE reservation_inventory SET seeded_at = NOW()');
    await pool.query("INSERT INTO reservation_daemon_inventory (daemon_id, seeded_at) VALUES ('synthetic-daemon', NOW())");
  });
  afterEach(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function artifact(id: string, commit: string) {
    const path = buildDirFor(root, 'retained-stack', id);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, BUILD_MANIFEST_FILE), JSON.stringify({ buildId: id, commit, builtAt: '2026-01-01T00:00:00Z', toolchain: 'synthetic' }));
    await writeFile(join(path, BUILD_COMPLETE_MARKER), '');
    await writeFile(join(path, 'synthetic-code.txt'), `synthetic code ${id}`);
  }
  async function apply(previous: string | null = 'synthetic previous config'): Promise<Applied> {
    await pool.query('UPDATE profiles SET engine_config = $1 WHERE name = $2', [previous, initial.name]);
    initial = (await profiles.findByName(initial.name))!;
    const applied = (await operations.beginDeploy({ profile: initial, version: selected, engine: 'srs', kind: 'apply', config: 'synthetic new config',
      admission: await operations.captureDeployAdmission(initial), snapshot: { daemonId: 'synthetic-daemon', containerIds: ['synthetic-old'] } }))!;
    await attempts.resolve(applied.attempt.id, { state: 'released', reason: null });
    await profiles.markTerminal(initial.name, 'RUNNING');
    await operations.transition(ownershipOf(applied.operation), ['applying'], 'watching');
    return applied;
  }
  async function publishLater() {
    await versions.publish(selected.id, { buildId: B, commitSha: B, contract });
    await versions.publish(selected.id, { buildId: C, commitSha: C,
      contract: { ...contract, features: { ...contract.features, sharedImageTags: false }, engineConfig: { srs: false, ome: true } } });
  }
  async function request(applied: Applied) {
    const profile = (await profiles.findByName(initial.name))!;
    return { profile, engine: 'srs' as const, ownership: ownershipOf(applied.operation), message: 'synthetic failed watch',
      admission: await operations.captureDeployAdmission(profile), snapshot: { daemonId: 'synthetic-daemon', containerIds: ['synthetic-current'] } };
  }
  async function legacyRequest(applied: Applied) {
    // Simulates an older internal caller. This value must never authorize the recovery artifact.
    return { ...await request(applied), version: (await versions.findById(selected.id))! };
  }
  async function mutationSnapshot() {
    return {
      profiles: (await pool.query('SELECT name, instance_id, status, engine_config, engine_config_revision, intent_revision, stack_version_id, port_slot, deploy_job_reference_id FROM profiles ORDER BY name')).rows,
      operations: (await pool.query('SELECT id, previous_config, previous_is_template, applied_revision, intent_revision, recovery_descriptor, recovery_reference_id, deployment_job_reference_id FROM engine_config_operations ORDER BY id')).rows,
      references: (await pool.query('SELECT * FROM build_references ORDER BY id')).rows,
      ports: (await pool.query('SELECT * FROM port_reservations ORDER BY id')).rows,
      attempts: (await pool.query('SELECT * FROM deploy_attempts ORDER BY id')).rows,
    };
  }
  async function assertInterrupted(applied: Applied) {
    assert.equal((await pool.query('SELECT state FROM engine_config_operations WHERE id = $1', [applied.operation.id])).rows[0].state, 'interrupted');
    assert.equal((await profiles.findByName(initial.name))!.engine_config_state, 'interrupted');
  }
  async function refused(pending: ReturnType<PostgresEngineConfigOperationRepository['beginRevertDeploy']>) {
    let result: Awaited<typeof pending> | undefined;
    try { result = await pending; } catch { return; }
    assert.equal(result, null, 'refused recovery must not return a new deploy claim');
  }
  function captureGate() {
    const entered = signal(), release = signal();
    const repository = new PostgresEngineConfigOperationRepository(pool, root, async (...args) => {
      const evidence = await captureRolloutRecovery(...args);
      entered.resolve();
      await release.promise;
      return evidence;
    });
    return { entered, release, repository };
  }
  async function reachedCapture(gate: ReturnType<typeof captureGate>, pending: ReturnType<typeof operations.beginRevertDeploy>) {
    await bounded(Promise.race([gate.entered.promise, pending.then(() => { throw new Error('recovery skipped saved-artifact verification'); })]));
  }
  function instrumentPool(hook: (text: string, pid: number, run: () => Promise<unknown>) => Promise<unknown>): Pool {
    return { query: pool.query.bind(pool), connect: async () => {
      const client = await pool.connect();
      const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      return { release: () => client.release(), query: (text: string, values?: unknown[]) => hook(text, pid, () => client.query(text, values)) };
    } } as unknown as Pool;
  }
  async function assertBlocked(pid: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if ((await pool.query<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])).rows[0]!.blocked) return;
      await delay(10);
    }
    throw new Error('the competing operation did not wait on the version lock');
  }

  it('recovers A after B then C even when current C cannot run this engine', async () => {
    const applied = await apply();
    await publishLater();
    const result = (await operations.beginRevertDeploy(await legacyRequest(applied)))!;
    assert.ok(result);
    assert.equal(result.descriptor.buildId, A);
    assert.equal(result.descriptor.version?.commitSha, A);
    assert.deepEqual(result.descriptor.version?.contract, contract);
    assert.equal(result.attempt.kind, 'shared');
    assert.equal((await profiles.findByName(initial.name))!.engine_config_state, 'reverting');
    assert.equal((await pool.query('SELECT engine_config FROM profiles')).rows[0].engine_config, 'synthetic previous config');
    assert.equal((await versions.findById(selected.id))!.buildId, C);
  });

  it('accepts a recovery request without any caller-selected version', async () => {
    const applied = await apply();
    const input = await request(applied);
    const result = await operations.beginRevertDeploy(input);
    assert.equal(result?.descriptor.buildId, A);
  });

  it('keeps the exact saved build across later rebuilds of the same commit', async () => {
    const applied = await apply();
    await versions.publish(selected.id, { buildId: `${A}-r1`, commitSha: A, contract });
    await versions.publish(selected.id, { buildId: `${A}-r2`, commitSha: A, contract });
    assert.equal((await operations.beginRevertDeploy(await legacyRequest(applied)))?.descriptor.buildId, A);
  });

  for (const previous of ['synthetic previous config', null]) {
    it(`creates a fresh recovery job and preserves the original hold for ${previous === null ? 'template' : 'config'} restoration`, async () => {
      const applied = await apply(previous);
      await pool.query('UPDATE build_references SET resolved_at = NOW() WHERE id = $1', [applied.descriptor.referenceId]);
      const oldJob = (await pool.query('SELECT * FROM build_references WHERE id = $1', [applied.descriptor.referenceId])).rows[0];
      const oldHold = (await pool.query('SELECT * FROM build_references WHERE id = $1', [applied.operation.recoveryReferenceId])).rows[0];
      const result = (await operations.beginRevertDeploy(await legacyRequest(applied)))!;
      assert.ok(result);
      assert.notEqual(result.descriptor.referenceId, applied.descriptor.referenceId);
      assert.equal(result.operation.deploymentJobReferenceId, result.descriptor.referenceId);
      assert.equal(result.operation.appliedRevision, applied.operation.appliedRevision + 1);
      assert.equal(result.profile.intent_revision, applied.profile.intent_revision);
      assert.deepEqual(result.operation.recoveryDescriptor, applied.operation.recoveryDescriptor);
      assert.equal(result.operation.recoveryReferenceId, oldHold.id);
      assert.deepEqual((await pool.query('SELECT * FROM build_references WHERE id = $1', [oldHold.id])).rows[0], oldHold);
      assert.deepEqual((await pool.query('SELECT * FROM build_references WHERE id = $1', [oldJob.id])).rows[0], oldJob);
      const current = (await pool.query('SELECT engine_config, deploy_job_reference_id FROM profiles')).rows[0];
      assert.equal(current.engine_config, previous);
      assert.equal(current.deploy_job_reference_id, result.descriptor.referenceId);
    });
  }

  it('reloads persisted A evidence in a new repository after publication and process loss', async () => {
    const applied = await apply();
    await publishLater();
    const restarted = new PostgresEngineConfigOperationRepository(pool, root);
    const saved = (await restarted.findById(applied.operation.id))!;
    const input = { ...await legacyRequest(applied), ownership: ownershipOf(saved) };
    const recovered = await restarted.beginRevertDeploy(input);
    assert.equal(recovered?.descriptor.buildId, A);
    assert.deepEqual(recovered?.operation.recoveryDescriptor, saved.recoveryDescriptor);
  });

  for (const changed of ['missing artifact', 'changed payload', 'changed manifest', 'changed complete'] as const) {
    it(`interrupts ${changed} without config, job, port or attempt writes`, async () => {
      const applied = await apply();
      const path = buildDirFor(root, selected.name, A);
      if (changed === 'missing artifact') await rm(path, { recursive: true });
      else if (changed === 'changed payload') await writeFile(join(path, 'synthetic-code.txt'), 'synthetic tampered payload');
      else await writeFile(join(path, changed === 'changed manifest' ? BUILD_MANIFEST_FILE : BUILD_COMPLETE_MARKER), `${await readFile(join(path, changed === 'changed manifest' ? BUILD_MANIFEST_FILE : BUILD_COMPLETE_MARKER), 'utf8')}\n`);
      const before = await mutationSnapshot();
      await refused(operations.beginRevertDeploy(await legacyRequest(applied)));
      assert.deepEqual(await mutationSnapshot(), before);
      await assertInterrupted(applied);
    });
  }

  for (const change of [
    "resolved_at = NOW()", "profile_instance_id = '11111111-1111-4111-8111-111111111111'", 'intent_revision = intent_revision + 1',
    `build_id = '${B}'`, "holder_kind = 'job'", "holder_id = 'another-owner'", "services = ARRAY['ome']",
  ]) {
    it(`refuses an operation hold with ${change.split(' = ')[0]} changed`, async () => {
      const applied = await apply();
      await pool.query(`UPDATE build_references SET ${change} WHERE id = $1`, [applied.operation.recoveryReferenceId]);
      const before = await mutationSnapshot();
      await refused(operations.beginRevertDeploy(await legacyRequest(applied)));
      assert.deepEqual(await mutationSnapshot(), before);
      await assertInterrupted(applied);
    });
  }

  it('refuses a missing independent operation hold', async () => {
    const applied = await apply();
    await pool.query('DELETE FROM build_references WHERE id = $1', [applied.operation.recoveryReferenceId]);
    const before = await mutationSnapshot();
    await refused(operations.beginRevertDeploy(await legacyRequest(applied)));
    assert.deepEqual(await mutationSnapshot(), before);
    await assertInterrupted(applied);
  });

  it('refuses an independent hold bound to another version', async () => {
    const applied = await apply();
    const other = await versions.insert({ name: 'other-version', gitRef: 'synthetic', rootPath: join(root, 'other-version') });
    await pool.query('UPDATE build_references SET version_id = $1 WHERE id = $2', [other.id, applied.operation.recoveryReferenceId]);
    const before = await mutationSnapshot();
    await refused(operations.beginRevertDeploy(await legacyRequest(applied)));
    assert.deepEqual(await mutationSnapshot(), before);
    await assertInterrupted(applied);
  });

  for (const historical of [false, true]) {
    it(`interrupts ${historical ? 'historical missing' : 'malformed'} evidence instead of borrowing current publication`, async () => {
      const applied = await apply();
      await pool.query('ALTER TABLE engine_config_operations DISABLE TRIGGER operation_recovery_immutable');
      await pool.query(historical
        ? 'UPDATE engine_config_operations SET recovery_descriptor = NULL, recovery_reference_id = NULL, deployment_job_reference_id = NULL'
        : "UPDATE engine_config_operations SET recovery_descriptor = jsonb_set(recovery_descriptor, '{artifactDigest}', '\"invalid\"')");
      await pool.query('ALTER TABLE engine_config_operations ENABLE TRIGGER operation_recovery_immutable');
      const before = await mutationSnapshot();
      await refused(operations.beginRevertDeploy(await legacyRequest(applied)));
      assert.deepEqual(await mutationSnapshot(), before);
      await assertInterrupted(applied);
    });
  }

  it('keeps a new legacy rollout explicitly unproven', async () => {
    await pool.query("UPDATE stack_versions SET layout = 'legacy', build_id = NULL WHERE id = $1", [selected.id]);
    selected = (await versions.findById(selected.id))!;
    const applied = await apply();
    const before = await mutationSnapshot();
    await refused(operations.beginRevertDeploy(await legacyRequest(applied)));
    assert.deepEqual(await mutationSnapshot(), before);
    await assertInterrupted(applied);
  });

  it('does not broaden automatic recovery to an explicitly interrupted operation', async () => {
    const applied = await apply();
    await operations.transition(ownershipOf(applied.operation), ['watching'], 'interrupted');
    const before = await mutationSnapshot();
    assert.equal(await operations.beginRevertDeploy(await legacyRequest(applied)), null);
    assert.deepEqual(await mutationSnapshot(), before);
  });

  for (const change of ['instance_id', 'intent_revision', 'engine_config_revision'] as const) {
    it(`cannot interrupt or restore after ${change} changes during verification`, async () => {
      const applied = await apply();
      const input = await legacyRequest(applied), gate = captureGate();
      const pending = gate.repository.beginRevertDeploy(input);
      try {
        await reachedCapture(gate, pending);
        await pool.query(change === 'instance_id' ? 'UPDATE profiles SET instance_id = $1' : `UPDATE profiles SET ${change} = ${change} + 1`, change === 'instance_id' ? [randomUUID()] : []);
        const before = await mutationSnapshot();
        gate.release.resolve();
        await refused(pending);
        assert.deepEqual(await mutationSnapshot(), before);
        assert.equal((await pool.query('SELECT state FROM engine_config_operations')).rows[0].state, 'watching');
      } finally { gate.release.resolve(); await pending.catch(() => {}); }
    });
  }

  it('rejects the NULL-pointer successor claim/cancel ABA without inferring ownership', async () => {
    const applied = await apply();
    const profile = (await profiles.findByName(initial.name))!;
    const successor = (await ledger.claim(profile.name, ['RUNNING'], selected, ['srs'], { ...deployOwnerOf(profile), intent: 'preserve' }))!;
    assert.ok(await ledger.cancelClaim(successor.profile, successor.descriptor.referenceId!, successor.previousStatus));
    const before = await mutationSnapshot();
    await refused(operations.beginRevertDeploy(await legacyRequest(applied)));
    assert.deepEqual(await mutationSnapshot(), before);
    await assertInterrupted(applied);
  });

  it('rejects a different same-intent active job after its verification was captured', async () => {
    const applied = await apply();
    const input = await legacyRequest(applied), gate = captureGate();
    const pending = gate.repository.beginRevertDeploy(input);
    try {
      await reachedCapture(gate, pending);
      const successor = (await ledger.claim(initial.name, ['RUNNING'], selected, ['srs'], { ...deployOwnerOf(input.profile), intent: 'preserve' }))!;
      await profiles.markTerminal(initial.name, 'RUNNING');
      const before = await mutationSnapshot();
      gate.release.resolve();
      await refused(pending);
      assert.deepEqual(await mutationSnapshot(), before);
      assert.equal((await pool.query('SELECT deploy_job_reference_id FROM profiles')).rows[0].deploy_job_reference_id, successor.descriptor.referenceId);
      assert.equal((await pool.query('SELECT state FROM engine_config_operations')).rows[0].state, 'watching');
    } finally { gate.release.resolve(); await pending.catch(() => {}); }
  });

  it('rechecks bounded metadata after full verification but before final admission', async () => {
    const applied = await apply();
    const input = await legacyRequest(applied), gate = captureGate();
    const pending = gate.repository.beginRevertDeploy(input);
    try {
      await reachedCapture(gate, pending);
      await writeFile(join(buildDirFor(root, selected.name, A), BUILD_COMPLETE_MARKER), 'synthetic changed marker');
      const before = await mutationSnapshot();
      gate.release.resolve();
      await refused(pending);
      assert.deepEqual(await mutationSnapshot(), before);
      await assertInterrupted(applied);
    } finally { gate.release.resolve(); await pending.catch(() => {}); }
  });

  it('refuses when its independent hold resolves and A is pruned during verification', async () => {
    const applied = await apply();
    await publishLater();
    await pool.query('UPDATE build_references SET resolved_at = NOW() WHERE id = $1', [applied.descriptor.referenceId]);
    const input = await legacyRequest(applied), gate = captureGate();
    const pending = gate.repository.beginRevertDeploy(input);
    try {
      await reachedCapture(gate, pending);
      await pool.query('UPDATE build_references SET resolved_at = NOW() WHERE id = $1', [applied.operation.recoveryReferenceId]);
      const pruner = new StackVersionService(versions, runner, new EventBus(), root, ledger);
      assert.ok((await pruner.pruneBuilds(selected.id)).removed.includes(A));
      const before = await mutationSnapshot();
      gate.release.resolve();
      await refused(pending);
      assert.deepEqual(await mutationSnapshot(), before);
      await assertInterrupted(applied);
    } finally { gate.release.resolve(); await pending.catch(() => {}); }
  });

  it('locks every located source and additional version in numeric order before the profile', async () => {
    const applied = await apply();
    const bundled = (await versions.findByName('bundled'))!;
    const other = await versions.insert({ name: 'other-version', gitRef: 'synthetic', rootPath: join(root, 'other-version') });
    for (const versionId of [other.id, bundled.id]) await pool.query(
      `INSERT INTO build_references (version_id, build_id, holder_kind, holder_id, services, profile_instance_id, intent_revision)
       VALUES ($1, $2, 'operation', $3, ARRAY['bee-node'], $4, $5)`,
      [versionId, D, String(applied.operation.id), applied.profile.instance_id, applied.profile.intent_revision]);
    const locked: number[] = [];
    let reachedProfile = false;
    const checked = instrumentPool(async (text, _pid, run) => {
      if (text.includes('FROM profiles') && text.includes('FOR UPDATE')) {
        assert.deepEqual(locked, [bundled.id, selected.id, other.id].sort((a, b) => a - b));
        reachedProfile = true;
      }
      const result = await run();
      if (text.includes('FROM stack_versions') && text.includes('FOR SHARE')) {
        locked.push(...(result as { rows: { id: number }[] }).rows.map(row => row.id));
      }
      return result;
    });
    const result = await new PostgresEngineConfigOperationRepository(checked, root).beginRevertDeploy(await legacyRequest(applied));
    assert.ok(reachedProfile);
    assert.equal(result?.descriptor.buildId, A);
  });

  it('refuses a newly discovered additional version until admission is prepared again', async () => {
    const applied = await apply();
    const input = await legacyRequest(applied), gate = captureGate();
    const pending = gate.repository.beginRevertDeploy(input);
    try {
      await reachedCapture(gate, pending);
      const other = await versions.insert({ name: 'late-version', gitRef: 'synthetic', rootPath: join(root, 'late-version') });
      await pool.query(
        `INSERT INTO build_references (version_id, build_id, holder_kind, holder_id, services, profile_instance_id, intent_revision)
         VALUES ($1, $2, 'operation', $3, ARRAY['bee-node'], $4, $5)`,
        [other.id, D, String(applied.operation.id), applied.profile.instance_id, applied.profile.intent_revision]);
      const before = await mutationSnapshot();
      gate.release.resolve();
      await refused(pending);
      assert.deepEqual(await mutationSnapshot(), before);
    } finally { gate.release.resolve(); await pending.catch(() => {}); }
  });

  for (const blocker of ['guard', 'port'] as const) {
    it(`refuses a ${blocker} conflict before restoring config`, async () => {
      const applied = await apply();
      const input = await legacyRequest(applied);
      if (blocker === 'guard') await attempts.open({ daemonId: 'synthetic-daemon', project: initial.name, jobId: 'synthetic-intervening', kind: 'fixed', services: ['srs'], preJobContainerIds: [] });
      else await pool.query("UPDATE port_reservations SET profile_name = 'synthetic-other-owner' WHERE id = (SELECT MIN(id) FROM port_reservations WHERE service = 'srs')");
      const before = await mutationSnapshot();
      await assert.rejects(operations.beginRevertDeploy(input));
      assert.deepEqual(await mutationSnapshot(), before);
    });
  }

  for (const table of ['build_references', 'deploy_attempts', 'engine_config_operations'] as const) {
    it(`rolls back every restoration write when ${table} refuses the final transaction`, async () => {
      const applied = await apply();
      const input = await legacyRequest(applied);
      await pool.query(`CREATE FUNCTION reject_retained_recovery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic recovery failure'; END; $$`);
      await pool.query(`CREATE TRIGGER reject_retained_recovery BEFORE ${table === 'engine_config_operations' ? 'UPDATE' : 'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_retained_recovery()`);
      const before = await mutationSnapshot();
      await assert.rejects(operations.beginRevertDeploy(input), /synthetic recovery failure/);
      assert.deepEqual(await mutationSnapshot(), before);
    });
  }

  it('keeps A during full verification while an independent deployment claim completes', async () => {
    const applied = await apply();
    await publishLater();
    await pool.query('UPDATE build_references SET resolved_at = NOW() WHERE id = $1', [applied.descriptor.referenceId]);
    const input = await legacyRequest(applied), gate = captureGate();
    const pending = gate.repository.beginRevertDeploy(input);
    try {
      await reachedCapture(gate, pending);
      const current = (await versions.findById(selected.id))!;
      const other = (await profiles.insertWithFreeSlot('independent-owner', 'streamer', 'RUNNING', { host: 'localhost', components: ['srs'] }, {
        stackVersionId: selected.id, slotCap: 10, daemonId: 'synthetic-daemon', table: ALLOCATION_CONTRACT.ports,
      }))!;
      assert.ok(await bounded(ledger.claim(other.name, ['RUNNING'], current, ['srs'], { ...deployOwnerOf(other), intent: 'advance' })));
      const pruner = new StackVersionService(versions, runner, new EventBus(), root, ledger);
      assert.ok((await bounded(pruner.pruneBuilds(selected.id))).kept.includes(A));
      gate.release.resolve();
      assert.equal((await pending)?.descriptor.buildId, A);
    } finally { gate.release.resolve(); await pending.catch(() => {}); }
  });

  for (const first of ['recovery', 'prune'] as const) {
    it(`coordinates actual pruning when ${first} holds the version lock first`, async () => {
      const applied = await apply();
      await publishLater();
      await pool.query('UPDATE build_references SET resolved_at = NOW() WHERE id = $1', [applied.descriptor.referenceId]);
      const input = await legacyRequest(applied);
      const locked = signal(), release = signal(), blocked = signal<number>();
      const recoveryPool = instrumentPool(async (text, pid, run) => {
        if (first === 'prune' && text.includes('FROM stack_versions') && text.includes('FOR SHARE')) blocked.resolve(pid);
        const result = await run();
        if (first === 'recovery' && text.includes('INSERT INTO build_references')) { locked.resolve(); await release.promise; }
        return result;
      });
      const prunePool = instrumentPool(async (text, pid, run) => {
        if (first === 'recovery' && text === 'SELECT id FROM stack_versions WHERE id = $1 FOR UPDATE') blocked.resolve(pid);
        const result = await run();
        if (first === 'prune' && text === 'SELECT id FROM stack_versions WHERE id = $1 FOR UPDATE') { locked.resolve(); await release.promise; }
        return result;
      });
      const repository = new PostgresEngineConfigOperationRepository(recoveryPool, root);
      const pruner = new StackVersionService(versions, runner, new EventBus(), root, new PostgresBuildLedger(prunePool, observer, root));
      let recovering: ReturnType<typeof operations.beginRevertDeploy> | undefined;
      let pruning: ReturnType<typeof pruner.pruneBuilds> | undefined;
      try {
        if (first === 'recovery') recovering = repository.beginRevertDeploy(input);
        else pruning = pruner.pruneBuilds(selected.id);
        const starting = recovering ?? pruning!;
        await bounded(Promise.race([locked.promise, starting.then(() => { throw new Error('operation did not reach its retained lock'); })]));
        if (first === 'recovery') pruning = pruner.pruneBuilds(selected.id);
        else recovering = repository.beginRevertDeploy(input);
        await assertBlocked(await bounded(blocked.promise));
      } finally { release.resolve(); }
      assert.equal((await bounded(recovering!))?.descriptor.buildId, A);
      assert.ok((await bounded(pruning!)).kept.includes(A));
      assert.ok(existsSync(buildDirFor(root, selected.name, A)));
      assert.equal(existsSync(buildDirFor(root, selected.name, D)), false);
    });
  }
});
