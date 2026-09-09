import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { EventBus } from '../../src/domain/EventBus.js';
import { PostgresBuildLedger } from '../../src/domain/versions/PostgresBuildLedger.js';
import { PostgresExecutionRootRepository } from '../../src/domain/versions/PostgresExecutionRootRepository.js';
import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import { StackVersionService } from '../../src/domain/versions/StackVersionService.js';
import type { StackVersionRecord } from '../../src/domain/versions/StackVersionRepository.js';
import { deployRootProblem, stackRootOf } from '../../src/domain/versions/stackPaths.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';
import { FakeScriptSpawner } from '../support/FakeScriptSpawner.js';

const port = Number(process.env.T04A_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't04a_test', connectionTimeoutMillis: 5000 };
const BUILD = 'a'.repeat(40);
function signal() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; }

describe('version removal before files disappear in isolated PostgreSQL', {
  skip: !Number.isInteger(port) || port < 1 || port > 65535, timeout: 60000,
}, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let root: string;
  let versions: PostgresStackVersionRepository;
  let selected: StackVersionRecord;
  let service: StackVersionService;
  let sentinels: string[];
  let ledger: PostgresBuildLedger;
  const observer = { mountedRootOf: async (): Promise<string | null> => { throw new Error('No Docker observation in removal tests.'); } };
  const runner = { run: (): never => { throw new Error('No real builds in removal tests.'); } };

  beforeEach(async () => {
    schema = `t04a_removal_${randomBytes(8).toString('hex')}`;
    root = await mkdtemp(join(tmpdir(), 't04a-version-removal-'));
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 8, application_name: schema, options: `-c search_path=${schema} -c statement_timeout=10000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    versions = new PostgresStackVersionRepository(pool);
    const inserted = await versions.insert({ name: 'review-stack', gitRef: 'review', rootPath: join(root, 'review-stack') });
    selected = (await versions.publish(inserted.id, { buildId: BUILD, commitSha: BUILD, contract: ALLOCATION_CONTRACT }))!;
    sentinels = [];
    for (const directory of ['review-stack', 'review-stack.repo', 'review-stack.builds']) {
      await mkdir(join(root, directory));
      const sentinel = join(root, directory, 'synthetic-sentinel');
      await writeFile(sentinel, 'owned fixture');
      sentinels.push(sentinel);
    }
    const artifact = join(root, 'review-stack.builds', BUILD);
    await mkdir(artifact);
    await writeFile(join(artifact, '.complete'), '');
    await writeFile(join(artifact, '.stack-manifest.json'), JSON.stringify({ buildId: BUILD, commit: BUILD, builtAt: '2026-09-09T00:00:00Z', toolchain: 'synthetic' }));
    ledger = new PostgresBuildLedger(pool, observer, root);
    service = new StackVersionService(versions, runner, new EventBus(), root, ledger);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function intact() {
    for (const file of sentinels) assert.equal(existsSync(file), true, 'all owned files must remain before a refused removal');
    assert.notEqual(await versions.findById(selected.id), null);
  }

  async function serviceRefuses() {
    let caught: unknown;
    try { await service.remove(selected.id); } catch (error) { caught = error; }
    await intact();
    assert.ok(caught instanceof Error, 'removal must explain its refusal');
  }

  function intercepted(hook: (sql: string, run: () => Promise<unknown>) => Promise<unknown>): Pool {
    return { query: pool.query.bind(pool), connect: async () => {
      const client = await pool.connect();
      return { release: () => client.release(), query: (sql: string, values?: unknown[]) => hook(sql, () => client.query(sql, values)) };
    } } as unknown as Pool;
  }

  async function assertBlocked() {
    const deadline = Date.now() + 3000;
    while (true) {
      const result = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'", [schema]);
      if (result.rowCount) return;
      assert.ok(Date.now() < deadline, 'the competing operation must actually wait for a row lock');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  async function simulatedRemovalMarker() {
    await writeFile(`${selected.rootPath}.removal.json`, JSON.stringify({ schema: 1, versionId: selected.id, name: selected.name, rootPath: selected.rootPath, removalId: randomUUID() }));
  }

  it('refuses cleanup through a configured ancestor symlink before touching payload or marker', async () => {
    const physical = join(root, 'physical', 'versions');
    await mkdir(physical, { recursive: true });
    await symlink(join(root, 'physical'), join(root, 'alias'));
    for (const name of ['review-stack', 'review-stack.repo', 'review-stack.builds']) await rename(join(root, name), join(physical, name));
    const aliased = join(root, 'alias', 'versions');
    await pool.query('UPDATE stack_versions SET root_path = $2 WHERE id = $1', [selected.id, join(aliased, selected.name)]);
    const removing = new StackVersionService(versions, runner, new EventBus(), aliased, ledger);
    await assert.rejects(removing.remove(selected.id), /owned|physical|ancestor|symbolic/i);
    for (const name of ['review-stack', 'review-stack.repo', 'review-stack.builds']) assert.equal(existsSync(join(physical, name, 'synthetic-sentinel')), true);
    assert.equal(existsSync(join(physical, 'review-stack.removal.json')), false);
    assert.notEqual(await versions.findById(selected.id), null);
  });

  it('new-version creation permits a missing versions directory under a validated existing parent', async () => {
    const missing = join(root, 'new-parent', 'versions');
    const fake = new FakeScriptSpawner();
    const creating = new StackVersionService(versions, fake, new EventBus(), missing, ledger);
    const added = await creating.add('first-stack', 'synthetic-ref');
    assert.equal(added.version.rootPath, join(missing, 'first-stack'));
    assert.equal(fake.spawned.length, 1);
    assert.equal(existsSync(missing), false, 'the fake runner creates no files or processes');
  });
  it('removes a failed first build whose versions directory was never created', async () => {
    const missing = join(root, 'new-parent', 'versions');
    const failed = await versions.insert({ name: 'first-stack', gitRef: 'synthetic-ref', rootPath: join(missing, 'first-stack') });
    await versions.markFailed(failed.id, 'synthetic runner never started');
    const removing = new StackVersionService(versions, runner, new EventBus(), missing, ledger);
    await removing.remove(failed.id);
    assert.equal(await versions.findById(failed.id), null);
    assert.equal(JSON.parse(await readFile(join(missing, 'first-stack.removal.json'), 'utf8')).versionId, failed.id);
    assert.deepEqual(await readdir(missing), ['first-stack.removal.json']);
  });

  it('does not create a missing removal parent through an ancestor symlink', async () => {
    const missing = join(root, 'new-parent', 'versions');
    const failed = await versions.insert({ name: 'first-stack', gitRef: 'synthetic-ref', rootPath: join(missing, 'first-stack') });
    await versions.markFailed(failed.id, 'synthetic runner never started');
    const elsewhere = join(root, 'unrelated-parent');
    await mkdir(elsewhere);
    await symlink(elsewhere, join(root, 'new-parent'));
    const removing = new StackVersionService(versions, runner, new EventBus(), missing, ledger);
    await assert.rejects(removing.remove(failed.id));
    assert.notEqual(await versions.findById(failed.id), null);
    assert.deepEqual(await readdir(elsewhere), []);
  });

  for (const evidence of ['malformed', 'active', 'future-ID']) {
    it(`new-version creation refuses ${evidence} removal evidence before retaining a row or starting a runner`, async () => {
      const name = 'new-stack';
      const rootPath = join(root, name);
      const nextId = Number((await pool.query('SELECT last_value + 1 AS id FROM stack_versions_id_seq')).rows[0].id);
      await writeFile(`${rootPath}.removal.json`, evidence === 'malformed' ? '{' : JSON.stringify({ schema: 1, versionId: nextId + (evidence === 'future-ID' ? 1 : 0), name, rootPath, removalId: randomUUID() }));
      let started = 0;
      const creating = new StackVersionService(versions, { run: (): never => { started++; throw new Error('No build may start.'); } }, new EventBus(), root, ledger);
      await assert.rejects(creating.add(name, 'synthetic-ref'), { name: 'StackVersionRemovalHeldError' });
      assert.equal(started, 0);
      assert.equal(await versions.findByName(name), null);
      assert.equal(existsSync(rootPath), false);
      assert.equal(existsSync(`${rootPath}.repo`), false);
      assert.equal(existsSync(`${rootPath}.builds`), false);
    });
  }

  for (const layout of ['legacy', 'builds'] as const) {
    for (const failure of ['rollback', 'connection-loss']) {
      it(`${layout} refuses admission after partial deletion and ${failure} with metadata surviving`, async () => {
        if (layout === 'legacy') {
          await pool.query("UPDATE stack_versions SET layout = 'legacy', build_id = NULL WHERE id = $1", [selected.id]);
          selected = (await versions.findById(selected.id))!;
        }
        const leaf = join(stackRootOf(selected), 'code.js');
        await writeFile(leaf, 'synthetic payload');
        if (failure === 'rollback') {
          await assert.rejects(versions.removeGuarded(selected, async () => {
            await simulatedRemovalMarker(); await rm(leaf); throw new Error('synthetic partial deletion');
          }), /synthetic partial deletion/);
        } else {
          const crashed = await pool.connect();
          await crashed.query('BEGIN');
          await crashed.query('SELECT id FROM stack_versions WHERE id = $1 FOR UPDATE', [selected.id]);
          await simulatedRemovalMarker(); await rm(leaf);
          crashed.release(true);
        }
        const restarted = new PostgresStackVersionRepository(pool);
        assert.notEqual(await restarted.findById(selected.id), null);
        assert.equal(existsSync(leaf), false);
        assert.equal(existsSync(join(root, 'review-stack.builds', BUILD, '.complete')), true);
        assert.equal(existsSync(join(root, 'review-stack.builds', BUILD, '.stack-manifest.json')), true);
        assert.match(deployRootProblem(selected) ?? '', /removal/i);
        const instanceId = randomUUID();
        await pool.query("INSERT INTO profiles (name, kind, port_slot, status, stack_version_id, instance_id) VALUES ('after-restart', 'viewer', 1, 'DEPLOYING', $1, $2)", [selected.id, instanceId]);
        const ownership = { instanceId, intentRevision: 0, configRevision: 0, stackVersionId: selected.id };
        await assert.rejects(new PostgresBuildLedger(pool, observer, root).describe('after-restart', selected, ['srs'], ownership), /removal/i);
        const owner = (await pool.query("SELECT instance_id, intent_revision, status, deploy_job_reference_id FROM profiles WHERE name = 'after-restart'")).rows[0];
        assert.deepEqual(owner, { instance_id: instanceId, intent_revision: 0, status: 'DEPLOYING', deploy_job_reference_id: null });
        await assert.rejects(restarted.markBuilding(selected.id), /removal/i);
        assert.equal((await restarted.findById(selected.id))!.status, 'ready');
        assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM build_references')).rows[0].count, 0);
      });
    }
  }

  it('a waiting markBuilding sees the deletion marker after removal rolls back', async () => {
    const entered = signal(); const release = signal();
    const removal = versions.removeGuarded(selected, async () => {
      await simulatedRemovalMarker(); entered.resolve(); await release.promise; throw new Error('synthetic deletion failure');
    });
    const rejectedRemoval = assert.rejects(removal, /synthetic deletion failure/);
    let building: Promise<unknown> | undefined;
    try {
      await entered.promise;
      building = versions.markBuilding(selected.id);
      await assertBlocked(); release.resolve(); await rejectedRemoval;
      await assert.rejects(building, /removal/i);
      assert.equal((await versions.findById(selected.id))!.status, 'ready');
    } finally { release.resolve(); await rejectedRemoval; await building?.catch(() => {}); }
  });

  it('execution registration refuses a marked version before creating another hold', async () => {
    const instance = randomUUID();
    await pool.query("INSERT INTO profiles (name, kind, port_slot, status, stack_version_id, instance_id, intent_revision) VALUES ('owned', 'viewer', 1, 'DEPLOYING', $1, $2, 3)", [selected.id, instance]);
    await pool.query("INSERT INTO deploy_targets (alias, daemon_id, verified_at) VALUES ('localhost', 'synthetic-daemon', NOW())");
    const job = (await pool.query("INSERT INTO build_references (version_id, build_id, holder_kind, holder_id, services, profile_instance_id, intent_revision) VALUES ($1,$2,'job','owned',ARRAY['srs'],$3,3) RETURNING id", [selected.id, BUILD, instance])).rows[0].id;
    await pool.query("UPDATE profiles SET deploy_job_reference_id = $1 WHERE name = 'owned'", [job]);
    await simulatedRemovalMarker();
    const executions = new PostgresExecutionRootRepository(pool, join(root, '.executions'));
    await assert.rejects(executions.register({
      executionId: randomUUID(), source: { versionId: selected.id, buildId: BUILD, commit: BUILD, root: stackRootOf(selected), artifactDigest: 'd'.repeat(64) },
      profile: { name: 'owned', instanceId: instance, intentRevision: 3, status: 'DEPLOYING' },
      jobReferenceId: job, target: { alias: 'localhost', daemonId: 'synthetic-daemon' }, action: 'deploy', services: ['srs'],
    }), /removal/i);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM execution_roots')).rows[0].count, 0);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM build_references WHERE holder_kind = 'execution'")).rows[0].count, 0);
  });

  it('successful removal retains its tombstone and a fresh same-name ID can be admitted', async () => {
    await service.remove(selected.id);
    const marker = JSON.parse(await readFile(`${selected.rootPath}.removal.json`, 'utf8'));
    assert.equal(marker.versionId, selected.id);
    const replacement = await versions.insert({ name: selected.name, gitRef: 'new', rootPath: selected.rootPath! });
    assert.notEqual(replacement.id, selected.id);
    assert.equal(deployRootProblem(replacement), null);
    assert.notEqual(await versions.markBuilding(replacement.id), null);
  });

  for (const table of ['profiles', 'build_references', 'bundled_shipments', 'execution_roots']) {
    it(`a failed ${table} hold read cannot reach cleanup or delete the row`, async () => {
      const repository = new PostgresStackVersionRepository(intercepted(async (sql, run) => {
        if (new RegExp(`FROM ${table}\\b`, 'i').test(sql)) throw new Error(`synthetic ${table} read failure`);
        return run();
      }));
      let called = false;
      await assert.rejects(repository.removeGuarded(selected, async () => { called = true; }), new RegExp(`synthetic ${table} read failure`));
      assert.equal(called, false);
      await intact();
    });
  }

  it('retains the row on partial cleanup failure so an idempotent retry finishes', async () => {
    await assert.rejects(versions.removeGuarded(selected, async () => {
      await rm(join(root, 'review-stack'), { recursive: true });
      throw new Error('synthetic filesystem failure');
    }), /synthetic filesystem failure/);
    assert.notEqual(await versions.findById(selected.id), null);
    assert.equal(existsSync(sentinels[1]!), true);
    assert.equal(existsSync(sentinels[2]!), true);
    await service.remove(selected.id);
    assert.equal(await versions.findById(selected.id), null);
    for (const file of sentinels) assert.equal(existsSync(file), false);
  });

  for (const state of ['default', 'building', 'assigned']) {
    it(`rechecks a newly ${state} version before invoking cleanup`, async () => {
      if (state === 'default') await versions.setDefault(selected.id);
      if (state === 'building') await versions.markBuilding(selected.id);
      if (state === 'assigned') await pool.query("INSERT INTO profiles (name, port_slot, kind, status, stack_version_id) VALUES ('new-assignment',1,'viewer','STOPPED',$1)", [selected.id]);
      let called = false;
      await assert.rejects(versions.removeGuarded(selected, async () => { called = true; }), {
        name: { default: 'DefaultVersionError', building: 'StackBuildBusyError', assigned: 'StackVersionInUseError' }[state],
      });
      assert.equal(called, false);
      await intact();
    });
  }

  it('refuses a changed descriptor even when the caller mutates its expectation while waiting', async () => {
    const entered = signal(); const release = signal();
    const repository = new PostgresStackVersionRepository({ query: pool.query.bind(pool), connect: async () => {
      entered.resolve(); await release.promise; return pool.connect();
    } } as unknown as Pool);
    const mutable = structuredClone(selected);
    let called = false;
    const pending = repository.removeGuarded(mutable, async () => { called = true; });
    try {
      await entered.promise;
      await pool.query('UPDATE stack_versions SET root_path = $2 WHERE id = $1', [selected.id, join(root, 'changed')]);
      mutable.rootPath = join(root, 'changed');
      release.resolve();
      await assert.rejects(pending, /changed/i);
      assert.equal(called, false);
      await intact();
    } finally { release.resolve(); await pending.catch(() => {}); }
  });

  it('SQL reference insertion first makes removal wait and then refuse before cleanup', async () => {
    const writer = await pool.connect();
    let removal: Promise<unknown> | undefined;
    let called = false;
    try {
      await writer.query('BEGIN');
      await writer.query("INSERT INTO build_references (version_id, build_id, holder_kind, holder_id) VALUES ($1, $2, 'snapshot', 'synthetic-container')", [selected.id, BUILD]);
      removal = versions.removeGuarded(selected, async () => { called = true; });
      await assertBlocked(); await writer.query('COMMIT');
      await assert.rejects(removal, { name: 'StackVersionRemovalHeldError' });
      assert.equal(called, false);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM profiles WHERE stack_version_id = $1', [selected.id])).rows[0].count, 0);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM build_references')).rows[0].count, 1);
      await intact();
    } finally { await writer.query('ROLLBACK'); writer.release(); await removal?.catch(() => {}); }
  });

  it('removal first makes later SQL reference insertion refuse a deleted version', async () => {
    const entered = signal(); const release = signal();
    const writer = await pool.connect();
    const removal = versions.removeGuarded(selected, async () => {
      entered.resolve(); await release.promise;
      for (const file of sentinels) await rm(file);
    });
    let registration: Promise<unknown> | undefined;
    try {
      await entered.promise;
      await writer.query('BEGIN');
      registration = writer.query("INSERT INTO build_references (version_id, build_id, holder_kind, holder_id) VALUES ($1, $2, 'snapshot', 'synthetic-container')", [selected.id, BUILD]);
      await assertBlocked(); release.resolve(); await removal;
      await assert.rejects(registration, { code: '23503' });
      await writer.query('ROLLBACK');
      assert.equal(await versions.findById(selected.id), null);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM build_references')).rows[0].count, 0);
      for (const file of sentinels) assert.equal(existsSync(file), false);
    } finally { release.resolve(); await removal.catch(() => {}); await registration?.catch(() => {}); await writer.query('ROLLBACK'); writer.release(); }
  });

  it('an assigned initial ledger job first makes removal wait and then refuse the in-use version', async () => {
    const instanceId = randomUUID();
    await pool.query("INSERT INTO profiles (name, kind, port_slot, status, stack_version_id, instance_id) VALUES ('assigned-owner', 'viewer', 1, 'DEPLOYING', $1, $2)", [selected.id, instanceId]);
    const ownership = { instanceId, intentRevision: 0, configRevision: 0, stackVersionId: selected.id };
    const entered = signal(); const release = signal();
    const registering = new PostgresBuildLedger(intercepted(async (sql, run) => {
      const result = await run();
      if (sql.includes('INSERT INTO build_references')) { entered.resolve(); await release.promise; }
      return result;
    }), observer, root);
    const registration = registering.describe('assigned-owner', selected, ['srs'], ownership);
    let removal: Promise<unknown> | undefined;
    let called = false;
    try {
      await entered.promise;
      removal = versions.removeGuarded(selected, async () => { called = true; });
      await assertBlocked(); release.resolve();
      const descriptor = await registration;
      await assert.rejects(removal, { name: 'StackVersionInUseError' });
      assert.equal(called, false);
      const profile = (await pool.query("SELECT status, instance_id, deploy_job_reference_id FROM profiles WHERE name = 'assigned-owner'")).rows[0];
      assert.deepEqual(profile, { status: 'DEPLOYING', instance_id: instanceId, deploy_job_reference_id: descriptor.referenceId });
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM build_references')).rows[0].count, 1);
      await intact();
    } finally { release.resolve(); await registration.catch(() => {}); await removal?.catch(() => {}); }
  });

  it('removal after detachment makes a captured initial ledger job wait and then refuse the deleted version', async () => {
    const instanceId = randomUUID();
    await pool.query("INSERT INTO profiles (name, kind, port_slot, status, stack_version_id, instance_id) VALUES ('detached-owner', 'viewer', 1, 'DEPLOYING', $1, $2)", [selected.id, instanceId]);
    const ownership = { instanceId, intentRevision: 0, configRevision: 0, stackVersionId: selected.id };
    await pool.query("UPDATE profiles SET stack_version_id = 1 WHERE name = 'detached-owner'");
    const before = (await pool.query("SELECT * FROM profiles WHERE name = 'detached-owner'")).rows[0];
    const entered = signal(); const release = signal();
    const removal = versions.removeGuarded(selected, async () => {
      entered.resolve(); await release.promise;
      for (const file of sentinels) await rm(file);
    });
    let registration: Promise<unknown> | undefined;
    try {
      await entered.promise;
      registration = ledger.describe('detached-owner', selected, ['srs'], ownership);
      await assertBlocked(); release.resolve(); await removal;
      await assert.rejects(registration, /no longer exists/);
      assert.equal(await versions.findById(selected.id), null);
      assert.deepEqual((await pool.query("SELECT * FROM profiles WHERE name = 'detached-owner'")).rows[0], before);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM build_references')).rows[0].count, 0);
      for (const file of sentinels) assert.equal(existsSync(file), false);
    } finally { release.resolve(); await removal.catch(() => {}); await registration?.catch(() => {}); }
  });

  for (const operation of ['assignment', 'markBuilding']) {
    it(`${operation} first makes removal wait and refuse before cleanup`, async () => {
      const writer = await pool.connect();
      let removal: Promise<unknown> | undefined;
      let called = false;
      try {
        await writer.query('BEGIN');
        if (operation === 'assignment') await writer.query("INSERT INTO profiles (name, port_slot, kind, status, stack_version_id) VALUES ('assigned',1,'viewer','STOPPED',$1)", [selected.id]);
        else await writer.query("UPDATE stack_versions SET status = 'building' WHERE id = $1", [selected.id]);
        removal = versions.removeGuarded(selected, async () => { called = true; });
        await assertBlocked(); await writer.query('COMMIT');
        await assert.rejects(removal, { name: operation === 'assignment' ? 'StackVersionInUseError' : 'StackBuildBusyError' });
        assert.equal(called, false); await intact();
      } finally { await writer.query('ROLLBACK'); writer.release(); await removal?.catch(() => {}); }
    });

    it(`removal first prevents a late ${operation} from taking ownership`, async () => {
      const entered = signal(); const release = signal();
      const removal = versions.removeGuarded(selected, async () => { entered.resolve(); await release.promise; });
      let competing: Promise<unknown> | undefined;
      try {
        await entered.promise;
        competing = operation === 'assignment'
          ? pool.query("INSERT INTO profiles (name, port_slot, kind, status, stack_version_id) VALUES ('assigned',1,'viewer','STOPPED',$1)", [selected.id])
          : versions.markBuilding(selected.id);
        await assertBlocked(); release.resolve(); await removal;
        if (operation === 'assignment') await assert.rejects(competing, { code: '23503' });
        else assert.equal(await competing, null);
        assert.equal(await versions.findById(selected.id), null);
      } finally { release.resolve(); await removal.catch(() => {}); await competing?.catch(() => {}); }
    });
  }

  for (const holder of ['job', 'snapshot', 'operation', 'execution']) {
    it(`keeps files and row while an unresolved ${holder} reference remains`, async () => {
      await pool.query('INSERT INTO build_references (version_id, build_id, holder_kind, holder_id) VALUES ($1,$2,$3,$4)', [selected.id, BUILD, holder, 'synthetic-owner']);
      await serviceRefuses();
    });
  }

  for (const state of ['registered', 'prepared', 'published', 'superseded']) {
    it(`keeps files and row for a ${state} shipment, including registration without a candidate`, async () => {
      const candidate = state === 'prepared' || state === 'published';
      const manifest = { buildId: BUILD, commit: BUILD, builtAt: '2026-09-09T00:00:00Z', toolchain: 'synthetic' };
      const metadata = { manifestBytes: JSON.stringify(manifest), manifestMode: 420, completeBytes: '', completeMode: 420 };
      await pool.query(`INSERT INTO bundled_shipments (shipment_id, version_id, package_digest, commit_sha, expected_publication_revision, root_path, state,
        candidate_build_id, candidate_kind, candidate_manifest, candidate_metadata, artifact_digest, candidate_contract, receipt_revision, published_at)
        VALUES ($1,$2,$3,$4,0,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13,$14)`, [
        randomUUID(), selected.id, 'd'.repeat(64), BUILD, selected.rootPath, state,
        candidate ? BUILD : null, candidate ? 'reuse' : null, candidate ? JSON.stringify(manifest) : null,
        candidate ? JSON.stringify(metadata) : null, candidate ? 'e'.repeat(64) : null,
        candidate ? JSON.stringify(ALLOCATION_CONTRACT) : null, state === 'published' ? 1 : null,
        state === 'published' ? new Date() : null,
      ]);
      await serviceRefuses();
    });
  }

  for (const state of ['registered', 'copying', 'ready', 'launch-uncertain', 'deleting']) {
    it(`keeps files for a ${state} execution whose separate reference is missing`, async () => {
      await pool.query(`INSERT INTO execution_roots (execution_id, version_id, build_id, commit_sha, source_root, artifact_digest,
        profile_name, profile_instance_id, intent_revision, profile_status, job_reference_id, target_alias, daemon_id,
        project, action, services, root_path, reference_id, state, copy_token)
        VALUES ($1,$2,$3,$3,$4,$5,'removed-profile',$6,2,'DEPLOYING',555,'localhost','synthetic-daemon',
        'removed-profile','deploy',ARRAY['srs'],$7,556,$8,$9)`, [randomUUID(), selected.id, BUILD,
        join(root, 'review-stack.builds', BUILD), 'e'.repeat(64), randomUUID(), join(root, '.executions', randomUUID()), state, randomUUID()]);
      await serviceRefuses();
    });
  }

  it('still removes an unheld version and its three owned trees', async () => {
    await service.remove(selected.id);
    assert.equal(await versions.findById(selected.id), null);
    for (const file of sentinels) assert.equal(existsSync(file), false);
  });

  it('refuses a symlinked version tree before deleting any of the other trees', async () => {
    const outside = join(root, 'unrelated-owned-fixture');
    await mkdir(outside);
    await writeFile(join(outside, 'synthetic-sentinel'), 'unrelated fixture');
    await rm(join(root, 'review-stack'), { recursive: true });
    await symlink(outside, join(root, 'review-stack'));
    await assert.rejects(service.remove(selected.id), /symbolic link|owned.*director/i);
    await intact();
    assert.equal(await readFile(join(outside, 'synthetic-sentinel'), 'utf8'), 'unrelated fixture');
  });

  it('refuses an unowned root path rather than forgetting the version row', async () => {
    await pool.query('UPDATE stack_versions SET root_path = $2 WHERE id = $1', [selected.id, join(root, 'other-version')]);
    await assert.rejects(service.remove(selected.id), /root|owned/i);
    await intact();
  });
});
