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
import { PostgresExecutionRootRepository } from '../../src/domain/versions/PostgresExecutionRootRepository.js';
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

describe('explicit interrupted restore in PostgreSQL', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool, pool: Pool, schema: string, root: string;
  let profiles: ProfileRepository, versions: PostgresStackVersionRepository;
  let operations: PostgresEngineConfigOperationRepository, attempts: PostgresDeployAttemptRepository, ledger: PostgresBuildLedger;
  let initial: Profile, selected: StackVersionRecord;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 't01-explicit-restore-'));
    schema = `t01_explicit_restore_${randomBytes(8).toString('hex')}`;
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

  async function interrupt(applied: Applied) {
    await operations.transition(ownershipOf(applied.operation), ['watching', 'applying', 'reverting'], 'interrupted');
    return (await operations.findById(applied.operation.id))!;
  }
  async function restoreInput(applied: Applied) {
    const source = (await operations.findById(applied.operation.id))!;
    return { ...await request(applied), ownership: ownershipOf(source) };
  }
  async function stopUnlaunched(applied: Applied) {
    await attempts.resolve(applied.attempt.id, { state: 'released', reason: null });
    await profiles.markTerminal(initial.name, 'RUNNING');
    await interrupt(applied);
  }
  async function expectRefused(work: Promise<unknown>) {
    try { assert.equal(await work, null); } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
    }
  }

  for (const previous of ['synthetic previous config', null]) {
    it(`restores the saved ${previous === null ? 'template' : 'config'} with a fresh intent, operation and A job after B/C`, async () => {
      const applied = await apply(previous);
      const source = await interrupt(applied);
      await publishLater();
      const oldHold = (await pool.query('SELECT * FROM build_references WHERE id = $1', [source.recoveryReferenceId])).rows[0];
      const result = (await operations.beginRestorePreviousDeploy(await restoreInput(applied)))!;
      assert.ok(result);
      assert.notEqual(result.operation.id, source.id);
      assert.equal(result.operation.kind, 'restore-previous');
      assert.equal(result.operation.sourceOperationId, source.id);
      assert.equal(result.operation.state, 'reverting');
      assert.equal(result.profile.intent_revision, applied.profile.intent_revision + 1);
      assert.equal(result.profile.engine_config_revision, applied.profile.engine_config_revision + 1);
      assert.equal(result.operation.intentRevision, result.profile.intent_revision);
      assert.equal(result.operation.appliedRevision, result.profile.engine_config_revision);
      assert.equal(result.operation.previousConfig, source.previousConfig);
      assert.equal(result.operation.previousIsTemplate, source.previousIsTemplate);
      assert.deepEqual(result.operation.recoveryDescriptor, source.recoveryDescriptor);
      assert.equal(result.descriptor.buildId, A);
      assert.equal(result.operation.deploymentJobReferenceId, result.descriptor.referenceId);
      assert.notEqual(result.descriptor.referenceId, source.deploymentJobReferenceId);
      assert.notEqual(result.operation.recoveryReferenceId, source.recoveryReferenceId);
      const hold = (await pool.query('SELECT * FROM build_references WHERE id = $1', [result.operation.recoveryReferenceId])).rows[0];
      assert.equal(hold.holder_id, String(result.operation.id));
      assert.equal(hold.intent_revision, result.profile.intent_revision);
      assert.equal(hold.build_id, A);
      assert.equal(hold.resolved_at, null);
      assert.deepEqual((await pool.query('SELECT * FROM build_references WHERE id = $1', [source.recoveryReferenceId])).rows[0], oldHold);
      const historical = (await operations.findById(source.id))!;
      assert.equal(historical.state, 'superseded');
      assert.deepEqual(historical.recoveryDescriptor, source.recoveryDescriptor);
      assert.equal(historical.recoveryReferenceId, source.recoveryReferenceId);
      assert.equal(historical.intentRevision, source.intentRevision);
      assert.equal((await pool.query('SELECT engine_config FROM profiles')).rows[0].engine_config, previous);
      assert.equal((await versions.findById(selected.id))!.buildId, C);
    });
  }

  it('allows an explicit captured NULL pointer with a new intent while automatic recovery refuses it', async () => {
    const applied = await apply();
    const profile = (await profiles.findByName(initial.name))!;
    const other = (await ledger.claim(profile.name, ['RUNNING'], selected, ['srs'], { ...deployOwnerOf(profile), intent: 'preserve' }))!;
    assert.ok(await ledger.cancelClaim(other.profile, other.descriptor.referenceId!, other.previousStatus));
    await expectRefused(operations.beginRevertDeploy(await request(applied)));
    const result = (await operations.beginRestorePreviousDeploy(await restoreInput(applied)))!;
    assert.ok(result);
    assert.equal(result.profile.intent_revision, profile.intent_revision + 1);
    assert.equal(result.descriptor.buildId, A);
  });

  it('gives two competing explicit restores one winner without retagging the old job', async () => {
    const applied = await apply();
    await interrupt(applied);
    const input = await restoreInput(applied);
    const oldJob = (await pool.query('SELECT * FROM build_references WHERE id = $1', [applied.descriptor.referenceId])).rows[0];
    const results = await Promise.allSettled([
      operations.beginRestorePreviousDeploy(input), operations.beginRestorePreviousDeploy(input),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled' && result.value !== null).length, 1);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM engine_config_operations')).rows[0].count, 2);
    assert.deepEqual((await pool.query('SELECT * FROM build_references WHERE id = $1', [applied.descriptor.referenceId])).rows[0], oldJob);
  });

  it('keeps A through original interruption and two independently recorded restore attempts across restart', async () => {
    const original = await apply();
    await interrupt(original);
    const first = (await operations.beginRestorePreviousDeploy(await restoreInput(original)))!;
    await stopUnlaunched(first);
    await publishLater();
    const restarted = new PostgresEngineConfigOperationRepository(pool, root);
    const second = (await restarted.beginRestorePreviousDeploy(await restoreInput(first)))!;
    assert.equal(second.operation.sourceOperationId, first.operation.id);
    assert.equal(first.operation.sourceOperationId, original.operation.id);
    assert.deepEqual(second.operation.recoveryDescriptor, original.operation.recoveryDescriptor);
    assert.equal(second.operation.previousConfig, original.operation.previousConfig);
    assert.equal(second.descriptor.buildId, A);
    for (const operation of [original.operation, first.operation, second.operation]) {
      assert.equal((await pool.query('SELECT resolved_at FROM build_references WHERE id = $1', [operation.recoveryReferenceId])).rows[0].resolved_at, null);
    }
    const pruning = new StackVersionService(versions, runner, new EventBus(), root, ledger);
    assert.ok((await pruning.pruneBuilds(selected.id)).kept.includes(A));
  });

  for (const field of ['instance_id', 'intent_revision', 'engine_config_revision', 'deploy_job_reference_id'] as const) {
    it(`does not overwrite a successor whose ${field} changes during explicit verification`, async () => {
      const applied = await apply();
      await interrupt(applied);
      const input = await restoreInput(applied), gate = captureGate();
      const pending = gate.repository.beginRestorePreviousDeploy(input);
      try {
        await reachedCapture(gate, pending);
        if (field === 'instance_id') await pool.query('UPDATE profiles SET instance_id = $1', [randomUUID()]);
        else if (field === 'deploy_job_reference_id') await pool.query('UPDATE profiles SET deploy_job_reference_id = NULL');
        else await pool.query(`UPDATE profiles SET ${field} = ${field} + 1`);
        const before = await mutationSnapshot();
        gate.release.resolve();
        await expectRefused(pending);
        assert.deepEqual(await mutationSnapshot(), before);
        assert.equal((await operations.findById(applied.operation.id))!.state, 'interrupted');
      } finally { gate.release.resolve(); await pending.catch(() => {}); }
    });
  }

  for (const damage of ['resolved hold', 'wrong hold owner', 'missing artifact', 'changed config target', 'not interrupted'] as const) {
    it(`refuses ${damage} before explicit restoration writes`, async () => {
      const applied = await apply();
      await interrupt(applied);
      const input = await restoreInput(applied), gate = captureGate();
      const pending = gate.repository.beginRestorePreviousDeploy(input);
      try {
        await reachedCapture(gate, pending);
        if (damage === 'resolved hold') await pool.query('UPDATE build_references SET resolved_at = NOW() WHERE id = $1', [applied.operation.recoveryReferenceId]);
        else if (damage === 'wrong hold owner') await pool.query('UPDATE build_references SET intent_revision = intent_revision + 1 WHERE id = $1', [applied.operation.recoveryReferenceId]);
        else if (damage === 'missing artifact') await rm(buildDirFor(root, selected.name, A), { recursive: true });
        else if (damage === 'changed config target') await pool.query("UPDATE engine_config_operations SET previous_config = 'different synthetic target'");
        else await operations.transition(ownershipOf(applied.operation), ['interrupted'], 'superseded');
        const before = await mutationSnapshot();
        gate.release.resolve();
        await expectRefused(pending);
        assert.deepEqual(await mutationSnapshot(), before);
      } finally { gate.release.resolve(); await pending.catch(() => {}); }
    });
  }

  for (const blocker of ['port', 'attempt', 'launch-uncertain'] as const) {
    it(`refuses ${blocker} uncertainty before replacing the interrupted owner`, async () => {
      const applied = await apply();
      if (blocker === 'launch-uncertain') {
        const execution = new PostgresExecutionRootRepository(pool, join(root, 'executions'));
        await profiles.transitionStatus(initial.name, 'DEPLOYING', ['RUNNING']);
        const recovery = applied.operation.recoveryDescriptor!;
        assert.equal(recovery.kind, 'immutable-build');
        if (recovery.kind !== 'immutable-build') throw new Error('fixture requires immutable source');
        const registered = await execution.register({ executionId: randomUUID(), source: { versionId: selected.id, buildId: A, commit: A,
          root: applied.descriptor.root, artifactDigest: recovery.artifactDigest },
          profile: { name: initial.name, instanceId: applied.profile.instance_id, intentRevision: applied.profile.intent_revision, status: 'DEPLOYING' },
          jobReferenceId: applied.descriptor.referenceId!, target: { alias: 'localhost', daemonId: 'synthetic-daemon' }, action: 'deploy', services: ['srs'] });
        const copy = (await execution.beginCopy(registered.executionId))!;
        await execution.markReady(copy.executionId, copy.copyToken!, recovery.artifactDigest);
        await execution.claimLaunch(copy.executionId);
        await profiles.markTerminal(initial.name, 'RUNNING');
      }
      await interrupt(applied);
      const input = await restoreInput(applied);
      if (blocker === 'port') await pool.query("UPDATE port_reservations SET profile_name = 'other-owner' WHERE id = (SELECT MIN(id) FROM port_reservations WHERE service = 'srs')");
      else if (blocker === 'attempt') await attempts.open({ daemonId: 'synthetic-daemon', project: initial.name, jobId: 'synthetic-intervening', kind: 'fixed', services: ['srs'], preJobContainerIds: [] });
      const before = await mutationSnapshot();
      await assert.rejects(operations.beginRestorePreviousDeploy(input));
      assert.deepEqual(await mutationSnapshot(), before);
      assert.equal((await operations.findById(applied.operation.id))!.state, 'interrupted');
    });
  }

  for (const target of ['operation insert', 'job insert', 'hold insert', 'attempt insert', 'lineage write'] as const) {
    it(`rolls back source supersession and all new ownership when ${target} fails`, async () => {
      const applied = await apply();
      await interrupt(applied);
      const input = await restoreInput(applied);
      const table = target.startsWith('operation') || target === 'lineage write' ? 'engine_config_operations'
        : target.startsWith('attempt') ? 'deploy_attempts' : 'build_references';
      const condition = target === 'job insert' ? "NEW.holder_kind = 'job'" : target === 'hold insert' ? "NEW.holder_kind = 'operation'"
        : target === 'lineage write' ? 'NEW.source_operation_id IS NOT NULL' : 'TRUE';
      await pool.query(`CREATE FUNCTION reject_explicit_restore() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'synthetic explicit restore failure'; END IF; RETURN NEW; END; $$`);
      await pool.query(`CREATE TRIGGER reject_explicit_restore BEFORE ${target === 'lineage write' ? 'INSERT OR UPDATE' : 'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_explicit_restore()`);
      const before = await mutationSnapshot();
      await assert.rejects(operations.beginRestorePreviousDeploy(input), /synthetic explicit restore failure/);
      assert.deepEqual(await mutationSnapshot(), before);
      assert.equal((await operations.findById(applied.operation.id))!.state, 'interrupted');
    });
  }

  it('makes lineage immutable from insertion, including a historical NULL link', async () => {
    const applied = await apply();
    await interrupt(applied);
    const restored = (await operations.beginRestorePreviousDeploy(await restoreInput(applied)))!;
    for (const [id, source] of [[restored.operation.id, null], [restored.operation.id, restored.operation.id], [applied.operation.id, restored.operation.id]]) {
      await assert.rejects(pool.query('UPDATE engine_config_operations SET source_operation_id = $2 WHERE id = $1', [id, source]), /lineage|source|immutable/i);
    }
    assert.equal((await operations.findById(restored.operation.id))!.sourceOperationId, applied.operation.id);
    assert.equal((await operations.findById(applied.operation.id))!.sourceOperationId, null);
  });
});
