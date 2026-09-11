import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { ProfileRepository } from '../../src/domain/ProfileRepository.js';
import { PostgresEngineConfigOperationRepository } from '../../src/domain/engineConfig/PostgresEngineConfigOperationRepository.js';
import { PostgresPortReservationRepository } from '../../src/domain/ports/PostgresPortReservationRepository.js';
import { ownershipOf } from '../../src/domain/engineConfig/operations.js';
import { PostgresBuildLedger } from '../../src/domain/versions/PostgresBuildLedger.js';
import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import { BUILD_COMPLETE_MARKER, BUILD_MANIFEST_FILE } from '../../src/domain/versions/buildManifest.js';
import { buildDirFor, stackRootOf } from '../../src/domain/versions/stackPaths.js';
import { inventoryOwnedTree, sha256 } from '../../src/domain/versions/ownedTreeInventory.js';
import type { StackVersionRecord } from '../../src/domain/versions/StackVersionRepository.js';
import type { Profile } from '../../src/types/index.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

const port = Number(process.env.T01_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't01_test', connectionTimeoutMillis: 10000 };
const A = 'a'.repeat(40);
const contract = { ...ALLOCATION_CONTRACT, engineConfig: { ...ALLOCATION_CONTRACT.engineConfig, srs: true } };
function signal() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('recovery capture blocked admission')), 5000); })]); }
  finally { clearTimeout(timer!); }
}

describe('config rollout recovery representation and holds in PostgreSQL', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let root: string;
  let profiles: ProfileRepository;
  let versions: PostgresStackVersionRepository;
  let operations: PostgresEngineConfigOperationRepository;
  let initial: Profile;
  let selected: StackVersionRecord;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 't01-recovery-hold-'));
    schema = `t01_recovery_hold_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 8, options: `-c search_path=${schema} -c statement_timeout=10000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    profiles = new ProfileRepository(pool);
    versions = new PostgresStackVersionRepository(pool);
    operations = new PostgresEngineConfigOperationRepository(pool, root);
    const version = await versions.insert({ name: 'recovery-stack', gitRef: 'synthetic', rootPath: join(root, 'recovery-stack') });
    const artifact = buildDirFor(root, version.name, A);
    await mkdir(artifact, { recursive: true });
    await writeFile(join(artifact, BUILD_MANIFEST_FILE), JSON.stringify({ buildId: A, commit: A, builtAt: '2026-01-01T00:00:00Z', toolchain: 'synthetic' }));
    await writeFile(join(artifact, BUILD_COMPLETE_MARKER), '');
    await writeFile(join(artifact, 'synthetic-code.txt'), 'synthetic artifact bytes');
    selected = (await versions.publish(version.id, { buildId: A, commitSha: A, contract }))!;
    initial = (await profiles.insertWithFreeSlot('recovery-owner', 'streamer', 'RUNNING', { host: 'localhost', components: ['srs'] }, {
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

  async function request() {
    return { profile: structuredClone(initial), version: structuredClone(selected), engine: 'srs' as const,
      admission: await operations.captureDeployAdmission(initial), snapshot: { daemonId: 'synthetic-daemon', containerIds: ['synthetic-old-container'] },
      kind: 'apply' as const, config: 'synthetic new config' };
  }

  async function allRows() {
    const result: Record<string, unknown[]> = {};
    for (const table of ['profiles', 'engine_config_operations', 'build_references', 'deploy_attempts', 'port_reservations']) result[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY 1`)).rows;
    return result;
  }

  function beforeConnection(work: () => Promise<void>): Pool {
    let once = true;
    return { query: pool.query.bind(pool), connect: async () => { if (once) { once = false; await work(); } return pool.connect(); } } as unknown as Pool;
  }

  for (const kind of ['apply', 'reset'] as const) {
    it(`${kind} persists exact recovery identity with an independent instance-owned operation hold`, async () => {
      const input = await request();
      const result = (await operations.beginDeploy({ ...input, kind, config: kind === 'reset' ? null : input.config }))!;
      const stored = (await pool.query('SELECT * FROM engine_config_operations WHERE id = $1', [result.operation.id])).rows[0];
      const inventory = await inventoryOwnedTree(stackRootOf(selected));
      const expected = { format: 1, kind: 'immutable-build',
        version: { id: selected.id, name: selected.name, rootPath: selected.rootPath, layout: 'builds', buildId: A, commitSha: A, contract },
        artifactDigest: sha256(JSON.stringify({ format: 1, rootMode: inventory.rootMode, entries: inventory.entries })),
        manifestHash: sha256(await readFile(join(stackRootOf(selected), BUILD_MANIFEST_FILE))),
        completeHash: sha256(await readFile(join(stackRootOf(selected), BUILD_COMPLETE_MARKER))) };
      assert.deepEqual(stored.recovery_descriptor, expected);
      assert.deepEqual(result.operation.recoveryDescriptor, expected);
      assert.equal(result.operation.deploymentJobReferenceId, result.descriptor.referenceId);
      assert.equal(stored.deployment_job_reference_id, result.descriptor.referenceId);
      assert.equal(result.operation.recoveryReferenceId, stored.recovery_reference_id);
      assert.notEqual(stored.recovery_reference_id, result.descriptor.referenceId);
      const hold = (await pool.query('SELECT * FROM build_references WHERE id = $1', [stored.recovery_reference_id])).rows[0];
      assert.equal(hold.holder_kind, 'operation');
      assert.equal(hold.holder_id, String(result.operation.id));
      assert.equal(hold.version_id, selected.id);
      assert.equal(hold.build_id, A);
      assert.equal(hold.profile_instance_id, result.profile.instance_id);
      assert.equal(hold.intent_revision, result.profile.intent_revision);
      assert.deepEqual(hold.services, ['srs']);
      assert.equal(hold.resolved_at, null);
      assert.deepEqual((await new PostgresEngineConfigOperationRepository(pool, root).findById(result.operation.id))!.recoveryDescriptor, expected);
    });
  }

  it('leaves historical operations explicitly without invented recovery evidence', async () => {
    const historical = await operations.begin({ profileName: initial.name, engine: 'srs', kind: 'apply', config: 'synthetic old API config',
      expectedRevision: initial.engine_config_revision, previousConfig: 'synthetic previous config', previousIsTemplate: false });
    assert.ok(historical);
    const stored = (await pool.query('SELECT * FROM engine_config_operations WHERE id = $1', [historical.operation.id])).rows[0];
    assert.equal(stored.recovery_descriptor, null);
    assert.equal(stored.recovery_reference_id, null);
    assert.equal(stored.deployment_job_reference_id, null);
    assert.equal(historical.operation.recoveryDescriptor, null);
  });

  for (const bundled of [false, true]) {
    it(`records ${bundled ? 'bundled' : 'added'} legacy facts without declaring a mutable root recoverable`, async () => {
      if (bundled) {
        selected = (await versions.findByName('bundled'))!;
        await versions.setContract(selected.id, contract);
        await pool.query('UPDATE profiles SET stack_version_id = $1', [selected.id]);
      } else await pool.query("UPDATE stack_versions SET layout = 'legacy', build_id = NULL WHERE id = $1", [selected.id]);
      selected = (await versions.findById(selected.id))!;
      initial = (await profiles.findByName(initial.name))!;
      const result = (await operations.beginDeploy(await request()))!;
      const stored = (await pool.query('SELECT * FROM engine_config_operations WHERE id = $1', [result.operation.id])).rows[0];
      assert.equal(stored.recovery_descriptor.kind, 'legacy-unproven');
      assert.equal(stored.recovery_descriptor.reason, 'mutable-legacy-source');
      assert.equal(stored.recovery_descriptor.version.rootPath, selected.rootPath);
      assert.equal(stored.recovery_descriptor.artifactDigest, undefined);
      assert.ok(stored.recovery_reference_id);
      const hold = (await pool.query('SELECT * FROM build_references WHERE id = $1', [stored.recovery_reference_id])).rows[0];
      assert.equal(hold.build_id, bundled ? 'bundled' : 'legacy');
      assert.equal(hold.resolved_at, null);
    });
  }

  it('rolls back config, operation, final job, ports and attempt when the operation hold insert fails', async () => {
    const input = await request();
    await pool.query("ALTER TABLE build_references ADD CONSTRAINT reject_operation_hold CHECK (holder_kind <> 'operation')");
    const before = await allRows();
    await assert.rejects(operations.beginDeploy(input), /reject_operation_hold/);
    assert.deepEqual(await allRows(), before);
  });

  it('rolls back every final write when binding the operation recovery reference fails', async () => {
    const input = await request();
    await pool.query("ALTER TABLE engine_config_operations ADD CONSTRAINT reject_recovery_binding CHECK (recovery_reference_id IS NULL)");
    const before = await allRows();
    await assert.rejects(operations.beginDeploy(input), /reject_recovery_binding/);
    assert.deepEqual(await allRows(), before);
  });

  it('keeps recovery authority when only the known-unlaunched job is cancelled', async () => {
    const result = (await operations.beginDeploy(await request()))!;
    const ledger = new PostgresBuildLedger(pool, { mountedRootOf: async () => { throw new Error('no Docker'); } }, root);
    assert.ok(await ledger.cancelClaim(result.profile, result.descriptor.referenceId!, result.previousStatus));
    const hold = (await pool.query("SELECT * FROM build_references WHERE holder_kind = 'operation' AND holder_id = $1", [String(result.operation.id)])).rows[0];
    assert.ok(hold);
    assert.equal(hold.resolved_at, null);
    assert.equal((await operations.findById(result.operation.id))!.state, 'applying');
    assert.equal(await profiles.engineConfigOf(initial.name), 'synthetic new config');
  });

  // Levi ruled on 2026-09-11: a rollout that has ended lets go of its hold,
  // because nothing can revert from it any more. These three have not ended.
  // `interrupted` is the one that matters: its recovery still deploys from the
  // build the hold protects.
  for (const state of ['watching', 'reverting', 'interrupted'] as const) {
    it(`keeps the hold while a rollout is ${state}`, async () => {
      const result = (await operations.beginDeploy(await request()))!;
      assert.ok(await operations.transition(ownershipOf(result.operation), ['applying'], state));
      const hold = (await pool.query("SELECT * FROM build_references WHERE holder_kind = 'operation' AND holder_id = $1", [String(result.operation.id)])).rows[0];
      assert.ok(hold);
      assert.equal(hold.resolved_at, null);
    });
  }

  /**
   * What leaving them cost, measured on 2026-09-11 against a real manager: one
   * config file applied through the interface left a deployment that could not
   * be removed at all, and no page offered a way to clear the hold.
   */
  for (const terminal of ['applied', 'reverted', 'failed', 'superseded'] as const) {
    it(`releases the hold when a rollout ends ${terminal}`, async () => {
      const reservations = new PostgresPortReservationRepository(pool);
      const result = (await operations.beginDeploy(await request()))!;
      assert.equal(await reservations.hasRemovalHold(initial.name), true, 'the open rollout holds its deployment');

      assert.ok(await operations.transition(ownershipOf(result.operation), ['applying'], terminal));

      const hold = (await pool.query('SELECT * FROM build_references WHERE id = $1', [result.operation.recoveryReferenceId])).rows[0];
      assert.equal(hold.holder_id, String(result.operation.id), 'the resolved hold is the one this rollout took');
      assert.notEqual(hold.resolved_at, null, 'the hold goes with the rollout that took it');
      await pool.query("UPDATE deploy_attempts SET state = 'released', resolved_at = NOW() WHERE project = $1", [initial.name]);
      assert.equal(await reservations.hasRemovalHold(initial.name), false, 'and the deployment can be removed');
    });
  }

  it('releases the hold of a rollout a new one supersedes', async () => {
    const first = (await operations.beginDeploy(await request()))!;
    await pool.query("UPDATE profiles SET status = 'RUNNING' WHERE name = $1", [initial.name]);
    await pool.query("UPDATE deploy_attempts SET state = 'released', resolved_at = NOW() WHERE project = $1", [initial.name]);
    initial = (await profiles.findByName(initial.name))!;

    const second = (await operations.beginDeploy(await request()))!;

    const old = (await pool.query('SELECT * FROM build_references WHERE id = $1', [first.operation.recoveryReferenceId])).rows[0];
    const current = (await pool.query('SELECT * FROM build_references WHERE id = $1', [second.operation.recoveryReferenceId])).rows[0];
    assert.notEqual(old.resolved_at, null, 'the superseded rollout let go');
    assert.equal(current.resolved_at, null, 'and the one that replaced it holds instead');
  });

  for (const field of ['recovery_descriptor', 'recovery_reference_id']) {
    it(`keeps committed ${field} immutable through subsequent operation writes`, async () => {
      const result = (await operations.beginDeploy(await request()))!;
      const before = (await pool.query('SELECT * FROM engine_config_operations WHERE id = $1', [result.operation.id])).rows[0];
      const expression = field === 'recovery_descriptor'
        ? "jsonb_set(recovery_descriptor, '{artifactDigest}', to_jsonb(repeat('b',64)))"
        : 'recovery_reference_id + 100';
      await assert.rejects(pool.query(`UPDATE engine_config_operations SET ${field} = ${expression} WHERE id = $1`, [result.operation.id]), /immutable/i);
      assert.deepEqual((await pool.query('SELECT * FROM engine_config_operations WHERE id = $1', [result.operation.id])).rows[0], before);
      assert.equal((await pool.query('SELECT resolved_at FROM build_references WHERE id = $1', [before.recovery_reference_id])).rows[0].resolved_at, null);
    });
  }

  for (const file of [BUILD_MANIFEST_FILE, BUILD_COMPLETE_MARKER]) {
    it(`rechecks exact ${file} bytes under the version lock after capture`, async () => {
      const input = await request();
      const before = await allRows();
      const changed = new PostgresEngineConfigOperationRepository(beforeConnection(async () => {
        const path = join(stackRootOf(selected), file);
        await writeFile(path, `${await readFile(path, 'utf8')}\n`);
      }), root);
      await assert.rejects(changed.beginDeploy(input), /recovery|evidence|changed/i);
      assert.deepEqual(await allRows(), before);
    });
  }

  it('refuses a source missing before capture without any partial admission writes', async () => {
    const input = await request();
    await rm(stackRootOf(selected), { recursive: true });
    const before = await allRows();
    await assert.rejects(operations.beginDeploy(input));
    assert.deepEqual(await allRows(), before);
  });

  it('does not hold admission locks while full recovery capture waits', async () => {
    const { captureRolloutRecovery } = await import('../../src/domain/engineConfig/rolloutRecoveryDescriptor.js');
    const entered = signal(); const release = signal();
    const input = await request();
    const waiting = new PostgresEngineConfigOperationRepository(pool, root, async (...args) => {
      entered.resolve(); await release.promise; return captureRolloutRecovery(...args);
    });
    const pending = waiting.beginDeploy(input);
    try {
      await bounded(entered.promise);
      const winner = await bounded(operations.beginDeploy(input));
      assert.ok(winner);
    } finally { release.resolve(); }
    assert.equal(await pending, null);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM build_references WHERE holder_kind = 'operation'")).rows[0].count, 1);
  });
});
