import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DeploymentOrchestrator, type DeployHooks, type DeployReservation } from '../../src/domain/DeploymentOrchestrator.js';
import { DeploymentGroupRepository } from '../../src/domain/DeploymentGroupRepository.js';
import { ContainerRepository } from '../../src/domain/ContainerRepository.js';
import { EngineConfigService } from '../../src/domain/engineConfig/EngineConfigService.js';
import { EngineConfigChecker } from '../../src/domain/engineConfig/engineConfigCheck.js';
import { PostgresPortReservationRepository } from '../../src/domain/ports/PostgresPortReservationRepository.js';
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
const contract = { ...ALLOCATION_CONTRACT, engineConfig: { ...ALLOCATION_CONTRACT.engineConfig, srs: true }, engineImages: { srs: 'synthetic-engine:1', ome: null } };
const observer = { mountedRootOf: async (): Promise<string | null> => { throw new Error('no Docker observation'); } };
const runner = { run: (): never => { throw new Error('no build'); } };
type Applied = NonNullable<Awaited<ReturnType<PostgresEngineConfigOperationRepository['beginDeploy']>>>;
function signal<T = void>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('retained recovery interleaving did not finish')), 5000); })]); }
  finally { clearTimeout(timer!); }
}

describe('real engine config service atomic admission', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool, pool: Pool, schema: string, root: string;
  let profiles: ProfileRepository, versions: PostgresStackVersionRepository;
  let operations: PostgresEngineConfigOperationRepository, attempts: PostgresDeployAttemptRepository, ledger: PostgresBuildLedger;
  let initial: Profile, selected: StackVersionRecord;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 't01-config-service-'));
    schema = `t01_config_service_${randomBytes(8).toString('hex')}`;
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
    await mkdir(join(path, 'engines', 'srs'), { recursive: true });
    await writeFile(join(path, '.env'), 'ENGINE=srs\n');
    await writeFile(join(path, 'engines', 'srs', 'srs.conf.template'), 'listen 1935;\n');
    await writeFile(join(path, 'engines', 'srs', 'entrypoint.sh'), '');
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

  function serviceHarness() {
    const containers = new ContainerRepository(pool), events = new EventBus();
    const daemon = { daemonId: async () => 'synthetic-daemon', containerIdsOf: async () => new Map([['srs', ['synthetic-before']]]),
      snapshot: async () => ({ daemonId: 'synthetic-daemon', containers: new Map([['srs', ['synthetic-before']]]) }) };
    const ports = new PostgresPortReservationRepository(pool);
    const orchestrator = new DeploymentOrchestrator(profiles, containers, { run: () => { throw new Error('No physical script may run'); } }, events,
      new DeploymentGroupRepository(pool), versions, ledger, attempts, daemon, operations, undefined,
      { daemonIdFor: async () => 'synthetic-daemon' }, ports, { publishedPorts: async () => ({ daemonId: 'synthetic-daemon', bindings: [] }) });
    const launches: { reservation: DeployReservation; profile: Profile; hooks: DeployHooks; attempts: unknown[] }[] = [];
    orchestrator.runReserved = async (reservation, profile, hooks = {}) => {
      launches.push({ reservation, profile, hooks, attempts: (await pool.query('SELECT * FROM deploy_attempts ORDER BY id')).rows });
      return { emitter: new EventEmitter(), kill: () => undefined };
    };
    const checker = new EngineConfigChecker(async () => ({ code: 0, stdout: '', stderr: '' }));
    checker.problem = async () => null;
    const watcher = { inspect: async () => null, logs: async () => '' };
    const service = new EngineConfigService(profiles, containers, orchestrator, versions, watcher, checker, events, operations,
      { intervalMs: 1, durationMs: 1 });
    return { service, launches, daemon, checker, orchestrator };
  }

  for (const action of ['apply', 'reset'] as const) {
    it(`${action} reaches the physical boundary with one final owned job and its existing attempt`, async () => {
      const h = serviceHarness();
      if (action === 'apply') await h.service.apply(initial.name, 'listen 1935; # synthetic candidate');
      else await h.service.reset(initial.name);
      assert.equal(h.launches.length, 1);
      const launch = h.launches[0]!;
      assert.equal(launch.attempts.length, 1, 'the final claim admits the creation attempt before any physical work');
      const operation = (await operations.findOpen(initial.instance_id))!;
      const job = (await pool.query('SELECT * FROM build_references WHERE id = $1', [launch.reservation.build?.referenceId])).rows[0];
      assert.equal(job.intent_revision, launch.profile.intent_revision);
      assert.equal(job.profile_instance_id, launch.profile.instance_id);
      assert.equal(operation.deploymentJobReferenceId, job.id);
      assert.equal(operation.intentRevision, launch.profile.intent_revision);
      assert.equal(operation.appliedRevision, launch.profile.engine_config_revision);
      assert.equal((await pool.query('SELECT deploy_job_reference_id FROM profiles')).rows[0].deploy_job_reference_id, job.id);
      assert.equal(operation.recoveryDescriptor?.version.buildId, A);
      assert.equal((await pool.query('SELECT resolved_at FROM build_references WHERE id = $1', [operation.recoveryReferenceId])).rows[0].resolved_at, null);
    });
  }

  it('refuses a port conflict without leaving a provisional job or changing config', async () => {
    const h = serviceHarness();
    await pool.query("UPDATE port_reservations SET profile_name = 'synthetic-other' WHERE service = 'srs'");
    const before = await mutationSnapshot();
    await assert.rejects(h.service.apply(initial.name, 'listen 1935; # synthetic candidate'));
    assert.deepEqual(await mutationSnapshot(), before);
    assert.equal(h.launches.length, 0);
  });

  it('refuses a creation guard before writing any config or ownership', async () => {
    const h = serviceHarness();
    await attempts.open({ daemonId: 'synthetic-daemon', project: initial.name, jobId: 'synthetic-blocker', kind: 'fixed', services: ['srs'], preJobContainerIds: [] });
    const before = await mutationSnapshot();
    await assert.rejects(h.service.apply(initial.name, 'listen 1935; # synthetic candidate'));
    assert.deepEqual(await mutationSnapshot(), before);
    assert.equal(h.launches.length, 0);
  });

  it('does not switch to B after the engine parser validated A', async () => {
    const h = serviceHarness(), entered = signal(), release = signal();
    h.checker.problem = async () => { entered.resolve(); await release.promise; return null; };
    const pending = h.service.apply(initial.name, 'listen 1935; # synthetic candidate');
    try {
      await bounded(entered.promise);
      await versions.publish(selected.id, { buildId: B, commitSha: B, contract });
      const before = await mutationSnapshot();
      release.resolve();
      await assert.rejects(pending);
      assert.deepEqual(await mutationSnapshot(), before);
      assert.equal(h.launches.length, 0);
    } finally { release.resolve(); await pending.catch(() => {}); }
  });

  it('does not mutate a replacement instance after engine validation', async () => {
    const h = serviceHarness(), entered = signal(), release = signal();
    h.checker.problem = async () => { entered.resolve(); await release.promise; return null; };
    const pending = h.service.apply(initial.name, 'listen 1935; # synthetic candidate');
    try {
      await bounded(entered.promise);
      await pool.query('UPDATE profiles SET instance_id = $1 WHERE name = $2', [randomUUID(), initial.name]);
      const before = await mutationSnapshot();
      release.resolve();
      await assert.rejects(pending);
      assert.deepEqual(await mutationSnapshot(), before);
      assert.equal(h.launches.length, 0);
    } finally { release.resolve(); await pending.catch(() => {}); }
  });

  it('checks retained attempt history after the pre-job snapshot before writing config', async () => {
    const h = serviceHarness();
    let snapshots = 0;
    h.daemon.snapshot = async () => {
      snapshots++;
      const intervening = await attempts.open({ daemonId: 'synthetic-daemon', project: initial.name, jobId: 'synthetic-intervening', kind: 'fixed', services: ['srs'], preJobContainerIds: [] });
      await attempts.resolve(intervening.id, { state: 'released', reason: null });
      return { daemonId: 'synthetic-daemon', containers: new Map([['srs', ['synthetic-before']]]) };
    };
    await assert.rejects(h.service.apply(initial.name, 'listen 1935; # synthetic candidate'), /history|snapshot|attempt/i);
    assert.equal(snapshots, 1);
    assert.equal((await pool.query('SELECT engine_config FROM profiles')).rows[0].engine_config, 'synthetic previous config');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM build_references')).rows[0].count, 0);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM engine_config_operations')).rows[0].count, 0);
    assert.equal(h.launches.length, 0);
  });

  it('explicit restore uses saved A and a fresh operation after C is published', async () => {
    const original = await apply();
    await operations.transition(ownershipOf(original.operation), ['watching'], 'interrupted');
    await publishLater();
    const h = serviceHarness();
    await h.service.recreateOnPrevious(initial.name);
    assert.equal(h.launches.length, 1);
    assert.equal(h.launches[0]!.reservation.build?.buildId, A);
    const operation = (await operations.findOpen(initial.instance_id))!;
    assert.equal(operation.kind, 'restore-previous');
    assert.equal(operation.sourceOperationId, original.operation.id);
    assert.deepEqual(operation.recoveryDescriptor, original.operation.recoveryDescriptor);
    assert.equal(operation.state, 'reverting');
  });

  it('boot recovery consumes the saved A descriptor and one fresh exact job', async () => {
    const original = await apply();
    await publishLater();
    const h = serviceHarness();
    await h.service.reconcileAtBoot();
    assert.equal(h.launches.length, 1);
    assert.equal(h.launches[0]!.reservation.build?.buildId, A);
    const current = (await operations.findById(original.operation.id))!;
    assert.equal(current.state, 'reverting');
    assert.equal(current.deploymentJobReferenceId, h.launches[0]!.reservation.build?.referenceId);
    assert.notEqual(current.deploymentJobReferenceId, original.operation.deploymentJobReferenceId);
    assert.equal(current.recoveryReferenceId, original.operation.recoveryReferenceId);
  });

  for (const action of ['apply', 'restore'] as const) {
    it(`${action} reports a preparation failure and retains interrupted recovery authority`, async () => {
      if (action === 'restore') {
        const original = await apply();
        await operations.transition(ownershipOf(original.operation), ['watching'], 'interrupted');
        await publishLater();
      }
      const h = serviceHarness();
      h.orchestrator.runReserved = async (reservation, profile) => {
        await profiles.markDeployError(profile.name, deployOwnerOf(profile), reservation.build!.referenceId,
          'synthetic launch preparation refused');
        throw new Error('synthetic launch preparation refused');
      };
      await assert.rejects(action === 'apply'
        ? h.service.apply(initial.name, 'listen 1935; # synthetic candidate')
        : h.service.recreateOnPrevious(initial.name), /synthetic launch preparation refused/);
      const operation = (await operations.findOpen(initial.instance_id))!;
      assert.equal(operation.state, 'interrupted');
      assert.match(operation.message ?? '', /synthetic launch preparation refused/);
      assert.equal((await profiles.findByName(initial.name))!.status, 'ERROR');
      const reference = (await pool.query('SELECT * FROM build_references WHERE id = $1', [operation.recoveryReferenceId])).rows[0];
      assert.equal(reference.resolved_at, null);
      assert.equal((await pool.query('SELECT deploy_job_reference_id FROM profiles')).rows[0].deploy_job_reference_id,
        operation.deploymentJobReferenceId);
    });
  }

  it('preparation failure cannot interrupt a successor job with the same instance and intent', async () => {
    const h = serviceHarness();
    let successor: unknown;
    h.orchestrator.runReserved = async (reservation, profile) => {
      const next = (await pool.query(`INSERT INTO build_references
        (version_id, build_id, holder_kind, holder_id, services, profile_instance_id, intent_revision)
        SELECT version_id, build_id, holder_kind, holder_id, services, profile_instance_id, intent_revision
          FROM build_references WHERE id = $1 RETURNING id`, [reservation.build!.referenceId])).rows[0].id;
      await pool.query('UPDATE profiles SET deploy_job_reference_id = $1 WHERE name = $2', [next, profile.name]);
      successor = (await pool.query('SELECT * FROM profiles WHERE name = $1', [profile.name])).rows[0];
      throw new Error('synthetic preparation lost ownership');
    };
    await assert.rejects(h.service.apply(initial.name, 'listen 1935; # synthetic candidate'), /synthetic preparation lost ownership/);
    assert.deepEqual((await pool.query('SELECT * FROM profiles WHERE name = $1', [initial.name])).rows[0], successor);
    assert.equal((await operations.findOpen(initial.instance_id))!.state, 'applying');
  });
});
