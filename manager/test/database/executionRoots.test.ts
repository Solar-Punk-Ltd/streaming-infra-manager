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
import { PostgresBuildLedger } from '../../src/domain/versions/PostgresBuildLedger.js';
import { PostgresExecutionRootRepository } from '../../src/domain/versions/PostgresExecutionRootRepository.js';
import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import { StackVersionService } from '../../src/domain/versions/StackVersionService.js';
import { buildDirFor } from '../../src/domain/versions/stackPaths.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

const port = Number(process.env.T04B_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't04b_test', connectionTimeoutMillis: 10000 };
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const digest = 'd'.repeat(64);
function signal<T = void>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('execution interleaving did not finish')), 5000); })]); }
  finally { clearTimeout(timer!); }
}

describe('execution ownership in isolated PostgreSQL', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let root: string;
  let versionId: number;
  let instanceId: string;
  let jobReferenceId: number;
  let repository: PostgresExecutionRootRepository;
  let versions: PostgresStackVersionRepository;
  let ledger: PostgresBuildLedger;
  let service: StackVersionService;
  const observer = { mountedRootOf: async (): Promise<string | null> => { throw new Error('no physical observation'); } };
  const runner = { run: (): never => { throw new Error('no script execution'); } };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 't04b-execution-'));
    schema = `t04b_execution_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 10, options: `-c search_path=${schema} -c statement_timeout=10000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    versions = new PostgresStackVersionRepository(pool);
    versionId = (await versions.findByName('bundled'))!.id;
    for (const buildId of [A, B, C]) {
      await mkdir(buildDirFor(root, 'bundled', buildId), { recursive: true });
      await writeFile(join(buildDirFor(root, 'bundled', buildId), '.complete'), 'synthetic');
    }
    await versions.publish(versionId, { buildId: A, commitSha: A, rootPath: join(root, 'bundled'), contract: ALLOCATION_CONTRACT });
    instanceId = randomUUID();
    await pool.query("INSERT INTO profiles (name, kind, port_slot, status, stack_version_id, instance_id, intent_revision) VALUES ('owned', 'viewer', 1, 'DEPLOYING', $1, $2, 3)", [versionId, instanceId]);
    await pool.query("INSERT INTO deploy_targets (alias, daemon_id, verified_at) VALUES ('localhost', 'synthetic-daemon', NOW())");
    jobReferenceId = (await pool.query<{ id: number }>(
      "INSERT INTO build_references (version_id, build_id, holder_kind, holder_id, services, profile_instance_id, intent_revision) VALUES ($1, $2, 'job', 'owned', ARRAY['srs'], $3, 3) RETURNING id",
      [versionId, A, instanceId],
    )).rows[0]!.id;
    await pool.query("UPDATE profiles SET deploy_job_reference_id = $1 WHERE name = 'owned'", [jobReferenceId]);
    repository = new PostgresExecutionRootRepository(pool, join(root, '.executions'));
    ledger = new PostgresBuildLedger(pool, observer, root);
    service = new StackVersionService(versions, runner, new EventBus(), root, ledger);
  });
  afterEach(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    if (root) await rm(root, { recursive: true, force: true });
  });
  function proposal() {
    return {
      executionId: randomUUID(),
      source: { versionId, buildId: A, commit: A, root: buildDirFor(root, 'bundled', A), artifactDigest: digest },
      profile: { name: 'owned', instanceId, intentRevision: 3, status: 'DEPLOYING' as const },
      jobReferenceId, target: { alias: 'localhost', daemonId: 'synthetic-daemon' }, action: 'deploy' as const, services: ['srs'],
    };
  }
  async function counts() {
    return (await pool.query("SELECT (SELECT COUNT(*)::int FROM execution_roots) AS roots, (SELECT COUNT(*)::int FROM build_references WHERE holder_kind = 'execution') AS holds")).rows[0];
  }
  async function ready(input = proposal()) {
    await repository.register(input);
    const copying = (await repository.beginCopy(input.executionId))!;
    return (await repository.markReady(input.executionId, copying.copyToken!, digest))!;
  }
  async function publishLaterBuilds() {
    for (const buildId of [B, C]) await versions.publish(versionId, { buildId, commitSha: buildId, contract: ALLOCATION_CONTRACT });
  }
  function instrumentPool(hook: (text: string, pid: number, run: () => Promise<unknown>) => Promise<unknown>): Pool {
    return { query: pool.query.bind(pool), connect: async () => {
      const client = await pool.connect();
      const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      return { release: () => client.release(), query: (text: string, values?: unknown[]) => hook(text, pid, () => client.query(text, values)) };
    } } as unknown as Pool;
  }
  async function assertBlocked(pid: number) {
    for (let tick = 0; tick < 200; tick++) {
      if ((await pool.query<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])).rows[0]!.blocked) return;
      await delay(10);
    }
    throw new Error('expected a version-row lock wait');
  }

  it('records exact ownership and a source hold with a configured UUID root', async () => {
    const input = proposal();
    const record = await repository.register(input);
    assert.deepEqual(record.source, input.source);
    assert.deepEqual(record.profile, input.profile);
    assert.deepEqual(record.target, input.target);
    assert.equal(record.project, input.profile.name);
    assert.equal(record.root, join(root, '.executions', input.executionId, 'tree'));
    assert.equal(record.state, 'registered');
    assert.equal(record.jobReferenceId, jobReferenceId);
    assert.deepEqual(await counts(), { roots: 1, holds: 1 });
    const hold = (await ledger.openReferences(versionId)).find(row => row.holderKind === 'execution')!;
    assert.equal(hold.buildId, A);
    assert.equal(hold.holderId, input.executionId);
    assert.equal(existsSync(record.root), false, 'registration does not perform filesystem work');
  });

  it('replays only an identical request without allocating another hold', async () => {
    const input = proposal();
    const first = await repository.register(input);
    assert.deepEqual(await repository.register(structuredClone(input)), first);
    for (const changed of [
      { ...input, source: { ...input.source, artifactDigest: 'e'.repeat(64) } },
      { ...input, profile: { ...input.profile, intentRevision: 4 } },
      { ...input, services: ['srs', 'stream-uploader'] },
    ]) await assert.rejects(repository.register(changed));
    await assert.rejects(repository.register({ ...input, executionId: randomUUID() }), /job|already|execution/i);
    assert.deepEqual(await counts(), { roots: 1, holds: 1 });
  });

  for (const change of ['absent', 'resolved', 'old-instance', 'wrong-intent', 'null-instance', 'null-intent', 'wrong-build', 'wrong-kind', 'wrong-services'] as const) {
    it(`refuses a ${change} job hold without changing it or creating ownership`, async () => {
      const input = proposal();
      if (change === 'absent') await pool.query('DELETE FROM build_references WHERE id = $1', [jobReferenceId]);
      if (change === 'resolved') await pool.query('UPDATE build_references SET resolved_at = NOW() WHERE id = $1', [jobReferenceId]);
      if (change === 'old-instance') await pool.query('UPDATE build_references SET profile_instance_id = $2 WHERE id = $1', [jobReferenceId, randomUUID()]);
      if (change === 'wrong-intent') await pool.query('UPDATE build_references SET intent_revision = 2 WHERE id = $1', [jobReferenceId]);
      if (change === 'null-instance') await pool.query('UPDATE build_references SET profile_instance_id = NULL WHERE id = $1', [jobReferenceId]);
      if (change === 'null-intent') await pool.query('UPDATE build_references SET intent_revision = NULL WHERE id = $1', [jobReferenceId]);
      if (change === 'wrong-build') await pool.query('UPDATE build_references SET build_id = $2 WHERE id = $1', [jobReferenceId, B]);
      if (change === 'wrong-kind') await pool.query("UPDATE build_references SET holder_kind = 'snapshot' WHERE id = $1", [jobReferenceId]);
      if (change === 'wrong-services') await pool.query("UPDATE build_references SET services = ARRAY['bee-uploader'] WHERE id = $1", [jobReferenceId]);
      const before = (await pool.query('SELECT * FROM build_references WHERE id = $1', [jobReferenceId])).rows;
      await assert.rejects(repository.register(input));
      assert.deepEqual(await counts(), { roots: 0, holds: 0 });
      assert.deepEqual((await pool.query('SELECT * FROM build_references WHERE id = $1', [jobReferenceId])).rows, before);
    });
  }

  for (const change of ['instance', 'intent', 'status', 'target'] as const) {
    it(`refuses registration after current ${change} ownership changes`, async () => {
      const input = proposal();
      if (change === 'instance') await pool.query("UPDATE profiles SET instance_id = $1 WHERE name = 'owned'", [randomUUID()]);
      if (change === 'intent') await pool.query("UPDATE profiles SET intent_revision = 4 WHERE name = 'owned'");
      if (change === 'status') await pool.query("UPDATE profiles SET status = 'REMOVING' WHERE name = 'owned'");
      if (change === 'target') await pool.query("UPDATE deploy_targets SET daemon_id = 'another-daemon' WHERE alias = 'localhost'");
      await assert.rejects(repository.register(input));
      assert.deepEqual(await counts(), { roots: 0, holds: 0 });
    });
  }

  it('requires the registered alias to match the profile host even when both aliases reach one daemon', async () => {
    const input = proposal();
    await pool.query("INSERT INTO deploy_targets (alias, daemon_id, verified_at) VALUES ('second-alias', 'synthetic-daemon', NOW())");
    await pool.query("UPDATE profiles SET host = 'second-alias' WHERE name = 'owned'");
    await assert.rejects(repository.register(input));
    assert.deepEqual(await counts(), { roots: 0, holds: 0 });
    assert.equal((await repository.register({ ...input, target: { ...input.target, alias: 'second-alias' } })).target.alias, 'second-alias');
  });

  it('lets only one duplicate copier start and refuses another token or digest at readiness', async () => {
    const input = proposal();
    await repository.register(input);
    const copies = await Promise.all(Array.from({ length: 6 }, () => repository.beginCopy(input.executionId)));
    const copying = copies.filter(Boolean);
    assert.equal(copying.length, 1);
    await assert.rejects(repository.markReady(input.executionId, randomUUID(), digest));
    await assert.rejects(repository.markReady(input.executionId, copying[0]!.copyToken!, 'e'.repeat(64)));
    assert.equal((await repository.find(input.executionId))!.state, 'copying');
    assert.equal(await repository.claimUnstartedCleanup(input.executionId), null);
  });

  it('permits only one of starting a copy and unstarted cleanup', async () => {
    const input = proposal();
    await repository.register(input);
    const [copy, cleanup] = await Promise.all([repository.beginCopy(input.executionId), repository.claimUnstartedCleanup(input.executionId)]);
    assert.equal(Number(Boolean(copy)) + Number(Boolean(cleanup)), 1);
  });

  it('permits only one of launch intent and cleanup and retains the hold until cleanup finishes', async () => {
    const record = await ready();
    const [launch, cleanup] = await Promise.all([repository.claimLaunch(record.executionId), repository.claimUnstartedCleanup(record.executionId)]);
    assert.equal(Number(Boolean(launch)) + Number(Boolean(cleanup)), 1);
    if (launch) {
      assert.equal(launch.state, 'launch-uncertain');
      assert.equal(await repository.claimLaunch(record.executionId), null);
      assert.equal(await repository.claimUnstartedCleanup(record.executionId), null);
    } else {
      await assert.rejects(repository.completeCleanup(record.executionId, async () => { throw new Error('synthetic cleanup failure'); }), /synthetic cleanup failure/);
      assert.equal((await repository.find(record.executionId))!.state, 'deleting');
      assert.ok((await ledger.openReferences(versionId)).some(row => row.holderKind === 'execution'));
      await repository.completeCleanup(record.executionId, async current => { assert.equal(current.root, record.root); });
      assert.equal((await repository.find(record.executionId))!.state, 'released');
      assert.equal((await ledger.openReferences(versionId)).some(row => row.holderKind === 'execution'), false);
      assert.ok((await ledger.openReferences(versionId)).some(row => row.id === jobReferenceId), 'execution cleanup must not cancel the caller job hold');
    }
  });

  it('retains a launch-uncertain copy through a new repository and completed job observation', async () => {
    const record = await ready();
    await repository.claimLaunch(record.executionId);
    await ledger.cancelUnstarted('owned', jobReferenceId);
    const restarted = new PostgresExecutionRootRepository(pool, join(root, '.executions'));
    assert.equal((await restarted.find(record.executionId))!.state, 'launch-uncertain');
    assert.equal(await restarted.claimUnstartedCleanup(record.executionId), null);
    await assert.rejects(restarted.completeCleanup(record.executionId, async () => { assert.fail('uncertain execution must not be deleted'); }));
    assert.ok((await ledger.openReferences(versionId)).some(row => row.holderKind === 'execution'));
  });

  it('deterministically permits launch before cleanup and never clears the uncertain hold', async () => {
    const record = await ready();
    assert.equal((await repository.claimLaunch(record.executionId))!.state, 'launch-uncertain');
    assert.equal(await repository.claimUnstartedCleanup(record.executionId), null);
    await assert.rejects(repository.completeCleanup(record.executionId, async () => { assert.fail('launched root must stay'); }));
    assert.ok((await ledger.openReferences(versionId)).some(row => row.holderKind === 'execution'));
  });

  it('deterministically permits cleanup before launch and retains its exact hold through failure and retry', async () => {
    const record = await ready();
    assert.equal((await repository.claimUnstartedCleanup(record.executionId))!.state, 'deleting');
    assert.equal(await repository.claimLaunch(record.executionId), null);
    await assert.rejects(repository.completeCleanup(record.executionId, async () => { throw new Error('synthetic deletion failure'); }), /synthetic deletion failure/);
    assert.equal((await repository.find(record.executionId))!.state, 'deleting');
    assert.ok((await ledger.openReferences(versionId)).some(row => row.holderKind === 'execution'));
    await repository.completeCleanup(record.executionId, async current => { assert.equal(current.executionId, record.executionId); });
    assert.equal((await repository.find(record.executionId))!.state, 'released');
    assert.equal((await ledger.openReferences(versionId)).some(row => row.holderKind === 'execution'), false);
    assert.ok((await ledger.openReferences(versionId)).some(row => row.id === jobReferenceId));
  });

  for (const change of ['instance', 'intent', 'status', 'daemon', 'job-resolution'] as const) {
    it(`refuses launch after changed ${change} even if the copy was ready`, async () => {
      const record = await ready();
      if (change === 'instance') await pool.query("UPDATE profiles SET instance_id = $1 WHERE name = 'owned'", [randomUUID()]);
      if (change === 'intent') await pool.query("UPDATE profiles SET intent_revision = 4 WHERE name = 'owned'");
      if (change === 'status') await pool.query("UPDATE profiles SET status = 'REMOVING' WHERE name = 'owned'");
      if (change === 'daemon') await pool.query("UPDATE deploy_targets SET daemon_id = 'replacement-daemon' WHERE alias = 'localhost'");
      if (change === 'job-resolution') await ledger.cancelUnstarted('owned', jobReferenceId);
      await assert.rejects(repository.claimLaunch(record.executionId));
      assert.equal((await repository.find(record.executionId))!.state, 'ready');
      assert.ok(await repository.claimUnstartedCleanup(record.executionId));
    });
  }

  it('registers captured A after B/C publication and protects it after the job hold resolves', async () => {
    const input = proposal();
    await publishLaterBuilds();
    const record = await repository.register(input);
    await ledger.cancelUnstarted('owned', jobReferenceId);
    assert.deepEqual(await service.pruneBuilds(versionId), { removed: [], kept: [A, B, C] });
    await repository.claimUnstartedCleanup(record.executionId);
    await repository.completeCleanup(record.executionId, async () => {});
    assert.deepEqual(await service.pruneBuilds(versionId), { removed: [A], kept: [B, C] });
  });

  it('makes pruning wait for ownership registration and then observe its execution hold', async () => {
    await publishLaterBuilds();
    const inserted = signal(); const release = signal(); const pruning = signal<number>();
    const registeringPool = instrumentPool(async (text, _pid, run) => {
      const result = await run();
      if (/INSERT INTO execution_roots/.test(text)) { inserted.resolve(); await release.promise; }
      return result;
    });
    const pruningPool = instrumentPool(async (text, pid, run) => {
      if (text === 'SELECT id FROM stack_versions WHERE id = $1 FOR UPDATE') pruning.resolve(pid);
      return run();
    });
    const pending = new PostgresExecutionRootRepository(registeringPool, join(root, '.executions')).register(proposal());
    const pruner = new StackVersionService(versions, runner, new EventBus(), root, new PostgresBuildLedger(pruningPool, observer, root));
    let pruned: ReturnType<StackVersionService['pruneBuilds']> | undefined;
    try {
      await bounded(inserted.promise);
      pruned = pruner.pruneBuilds(versionId);
      await assertBlocked(await bounded(pruning.promise));
    } finally { release.resolve(); }
    await bounded(pending);
    await bounded(pruned!);
    await ledger.cancelUnstarted('owned', jobReferenceId);
    assert.ok((await service.pruneBuilds(versionId)).kept.includes(A));
  });

  it('lets pruning finish first and refuses a resolved A job hold without recreating files', async () => {
    await publishLaterBuilds();
    await ledger.cancelUnstarted('owned', jobReferenceId);
    const pruning = signal(); const release = signal(); const registering = signal<number>();
    const original = ledger.openReferences.bind(ledger);
    ledger.openReferences = async id => { pruning.resolve(); await release.promise; return original(id); };
    const registeringPool = instrumentPool(async (text, pid, run) => {
      if (/FROM stack_versions.*FOR SHARE/s.test(text)) registering.resolve(pid);
      return run();
    });
    const pruned = service.pruneBuilds(versionId);
    let registration: Promise<unknown> | undefined;
    try {
      await bounded(pruning.promise);
      registration = assert.rejects(new PostgresExecutionRootRepository(registeringPool, join(root, '.executions')).register(proposal()));
      await assertBlocked(await bounded(registering.promise));
    } finally { release.resolve(); }
    assert.deepEqual(await bounded(pruned), { removed: [A], kept: [B, C] });
    await bounded(registration!);
    assert.equal(existsSync(buildDirFor(root, 'bundled', A)), false);
    assert.deepEqual(await counts(), { roots: 0, holds: 0 });
  });

  /**
   * Retirement, which is what lets a launched copy ever be deleted. Before
   * this the state had no way out, so every deploy pinned its build for good.
   */
  async function launched(input = proposal()) {
    const record = await ready(input);
    return (await repository.claimLaunch(record.executionId))!;
  }
  /** The next deploy of the same deployment: the old job finishes, a new one takes the profile. */
  async function nextDeployJob(): Promise<number> {
    await pool.query('UPDATE build_references SET resolved_at = NOW() WHERE id = $1 AND resolved_at IS NULL', [jobReferenceId]);
    jobReferenceId = (await pool.query<{ id: number }>(
      "INSERT INTO build_references (version_id, build_id, holder_kind, holder_id, services, profile_instance_id, intent_revision) VALUES ($1, $2, 'job', 'owned', ARRAY['srs'], $3, 3) RETURNING id",
      [versionId, A, instanceId],
    )).rows[0]!.id;
    await pool.query("UPDATE profiles SET deploy_job_reference_id = $1 WHERE name = 'owned'", [jobReferenceId]);
    return jobReferenceId;
  }

  it('keeps a replaced copy while its own job is still running', async () => {
    const replaced = await launched();
    jobReferenceId = (await pool.query<{ id: number }>(
      "INSERT INTO build_references (version_id, build_id, holder_kind, holder_id, services, profile_instance_id, intent_revision) VALUES ($1, $2, 'job', 'owned', ARRAY['srs'], $3, 3) RETURNING id",
      [versionId, A, instanceId],
    )).rows[0]!.id;
    await pool.query("UPDATE profiles SET deploy_job_reference_id = $1 WHERE name = 'owned'", [jobReferenceId]);
    await launched();

    assert.equal(await repository.claimRetiredCleanup(replaced.executionId), null);
    assert.equal((await repository.find(replaced.executionId))!.state, 'launch-uncertain');
  });

  it('keeps the copy a deployment is still running from, however old its job is', async () => {
    const only = await launched();
    await pool.query('UPDATE build_references SET resolved_at = NOW() WHERE id = $1', [only.jobReferenceId]);

    assert.equal(await repository.claimRetiredCleanup(only.executionId), null);
    assert.equal((await repository.find(only.executionId))!.state, 'launch-uncertain');
  });

  it('retires a replaced copy once its job has finished, and releases the build it held', async () => {
    const replaced = await launched();
    await nextDeployJob();
    const current = await launched();

    const claimed = await repository.claimRetiredCleanup(replaced.executionId);
    assert.equal(claimed?.state, 'deleting');
    let removed: string | null = null;
    const released = await repository.completeCleanup(replaced.executionId, async record => { removed = record.root; });
    assert.equal(removed, replaced.root);
    assert.equal(released.state, 'released');
    assert.deepEqual(await counts(), { roots: 2, holds: 2 });
    const holds = (await ledger.openReferences(versionId)).filter(row => row.holderKind === 'execution');
    assert.deepEqual(holds.map(row => row.holderId), [current.executionId], 'only the current copy still holds its build');
  });

  it('retires the copies of a deployment that was removed', async () => {
    const orphan = await launched();
    await pool.query('UPDATE build_references SET resolved_at = NOW() WHERE id = $1', [orphan.jobReferenceId]);
    await pool.query("DELETE FROM profiles WHERE name = 'owned'");

    assert.equal((await repository.claimRetiredCleanup(orphan.executionId))?.state, 'deleting');
  });

  it('retires a copy left by an earlier instance of the same name', async () => {
    const beforeRecreation = await launched();
    await pool.query('UPDATE build_references SET resolved_at = NOW() WHERE id = $1', [beforeRecreation.jobReferenceId]);
    await pool.query("UPDATE profiles SET instance_id = $1, deploy_job_reference_id = NULL WHERE name = 'owned'", [randomUUID()]);

    assert.equal((await repository.claimRetiredCleanup(beforeRecreation.executionId))?.state, 'deleting');
  });

  it('retires a copy a restart interrupted mid-copy, and refuses any other state', async () => {
    const registered = await repository.register(proposal());
    assert.equal(await repository.claimInterruptedCopyCleanup(registered.executionId), null, 'a registration made no files to remove yet');

    const copying = (await repository.beginCopy(registered.executionId))!;
    assert.equal(copying.state, 'copying');
    assert.equal((await repository.claimInterruptedCopyCleanup(registered.executionId))?.state, 'deleting');
    assert.equal(await repository.claimInterruptedCopyCleanup(registered.executionId), null, 'a claim is taken once');

    await nextDeployJob();
    const running = await launched();
    assert.equal(await repository.claimInterruptedCopyCleanup(running.executionId), null, 'a launched copy is never an interrupted one');
  });
});
