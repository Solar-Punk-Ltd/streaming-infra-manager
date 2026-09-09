import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { EventBus } from '../../src/domain/EventBus.js';
import { PostgresBuildLedger } from '../../src/domain/versions/PostgresBuildLedger.js';
import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import { StackVersionService } from '../../src/domain/versions/StackVersionService.js';
import type { StackVersionRecord } from '../../src/domain/versions/StackVersionRepository.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

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

  it('reference registration first makes removal wait and then refuse before cleanup', async () => {
    const entered = signal(); const release = signal();
    const registering = new PostgresBuildLedger(intercepted(async (sql, run) => {
      const result = await run();
      if (sql.includes('INSERT INTO build_references')) { entered.resolve(); await release.promise; }
      return result;
    }), observer, root);
    const registration = registering.describe('synthetic-owner', selected, ['srs']);
    let removal: Promise<unknown> | undefined;
    let called = false;
    try {
      await entered.promise;
      removal = versions.removeGuarded(selected, async () => { called = true; });
      await assertBlocked(); release.resolve(); await registration;
      await assert.rejects(removal, { name: 'StackVersionRemovalHeldError' });
      assert.equal(called, false); await intact();
    } finally { release.resolve(); await registration.catch(() => {}); await removal?.catch(() => {}); }
  });

  it('removal first makes later reference registration refuse a deleted version', async () => {
    const entered = signal(); const release = signal();
    const removal = versions.removeGuarded(selected, async () => { entered.resolve(); await release.promise; });
    let registration: Promise<unknown> | undefined;
    try {
      await entered.promise;
      registration = ledger.describe('synthetic-owner', selected, ['srs']);
      await assertBlocked(); release.resolve(); await removal;
      await assert.rejects(registration, /no longer exists/);
      assert.equal(await versions.findById(selected.id), null);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM build_references')).rows[0].count, 0);
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
