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
import { PostgresBundledShipmentRepository } from '../../src/domain/versions/PostgresBundledShipmentRepository.js';
import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import { buildDirFor } from '../../src/domain/versions/stackPaths.js';
import { StackVersionService } from '../../src/domain/versions/StackVersionService.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

const port = Number(process.env.T04B_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't04b_test', connectionTimeoutMillis: 10000 };
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const E = 'e'.repeat(40);
const artifactDigest = 'f'.repeat(64);
const candidate = {
  buildId: A, kind: 'reuse' as const,
  manifest: { buildId: A, commit: A, builtAt: '2026-09-09T00:00:00.000Z', toolchain: 'synthetic', inputGeneration: 1, inputHashes: {} },
};
function signal<T = void>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('pruning interleaving did not finish')), 5000);
    })]);
  } finally { clearTimeout(timer!); }
}

describe('pending bundled shipments and real pruning in isolated PostgreSQL', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let root: string;
  let versionId: number;
  let versions: PostgresStackVersionRepository;
  let shipments: PostgresBundledShipmentRepository;
  let ledger: PostgresBuildLedger;
  let service: StackVersionService;
  const observer = { mountedRootOf: async (): Promise<string | null> => { throw new Error('no container observation in this test'); } };
  const runner = { run: (): never => { throw new Error('no build in this test'); } };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 't04b-prune-'));
    schema = `t04b_prune_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 8, options: `-c search_path=${schema} -c statement_timeout=10000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    }
    versions = new PostgresStackVersionRepository(pool);
    versionId = (await versions.findByName('bundled'))!.id;
    shipments = new PostgresBundledShipmentRepository(pool, join(root, 'bundled'));
    ledger = new PostgresBuildLedger(pool, observer, root);
    service = new StackVersionService(versions, runner, new EventBus(), root, ledger);
    for (const id of [A, B, C, D, E]) {
      const path = buildDirFor(root, 'bundled', id);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, '.complete'), 'synthetic');
    }
    for (const id of [B, C]) {
      await versions.publish(versionId, { buildId: id, commitSha: id, rootPath: join(root, 'bundled'), contract: ALLOCATION_CONTRACT });
    }
    await pool.query("INSERT INTO build_references (version_id, build_id, holder_kind, holder_id, services) VALUES ($1, $2, 'snapshot', 'synthetic/srs', ARRAY['srs'])", [versionId, D]);
  });
  afterEach(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function register() {
    const item = { shipmentId: randomUUID(), commit: A, digest: randomBytes(32).toString('hex') };
    await shipments.register(item);
    return item;
  }
  async function verifyArtifact() { await readFile(join(buildDirFor(root, 'bundled', A), '.complete')); }
  async function active() { return (await pool.query('SELECT build_id, publication_revision FROM stack_versions WHERE id = $1', [versionId])).rows[0]; }

  function instrumentPool(hook: (text: string, pid: number, run: () => Promise<unknown>) => Promise<unknown>): Pool {
    return {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        return { release: () => client.release(), query: (text: string, values?: unknown[]) => hook(text, pid, () => client.query(text, values)) };
      },
    } as unknown as Pool;
  }
  async function assertBlocked(pid: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await pool.query<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid]);
      if (result.rows[0]!.blocked) return;
      await delay(10);
    }
    throw new Error('expected the competing operation to wait on the version row lock');
  }

  for (const state of ['registered', 'prepared'] as const) {
    it(`keeps a ${state} candidate with current, previous and mounted artifacts`, async () => {
      const item = await register();
      await shipments.reserveCandidate(item.shipmentId, candidate);
      if (state === 'prepared') await shipments.markPrepared(item.shipmentId, { artifactDigest, contract: ALLOCATION_CONTRACT });
      assert.deepEqual(await service.pruneBuilds(versionId), { removed: [E], kept: [A, B, C, D] });
      await verifyArtifact();
    });
  }

  it('waits for a reservation holding the row lock, then keeps its committed candidate', async () => {
    const item = await register();
    const reserved = signal();
    const release = signal();
    const pruning = signal<number>();
    const reservationPool = instrumentPool(async (text, _pid, run) => {
      const result = await run();
      if (text.startsWith('UPDATE bundled_shipments SET candidate_build_id')) { reserved.resolve(); await release.promise; }
      return result;
    });
    const pruningPool = instrumentPool(async (text, pid, run) => {
      if (text === 'SELECT id FROM stack_versions WHERE id = $1 FOR UPDATE') pruning.resolve(pid);
      return run();
    });
    const reserving = new PostgresBundledShipmentRepository(reservationPool, join(root, 'bundled')).reserveCandidate(item.shipmentId, candidate);
    const pruner = new StackVersionService(versions, runner, new EventBus(), root, new PostgresBuildLedger(pruningPool, observer, root));
    let pruned: ReturnType<StackVersionService['pruneBuilds']> | undefined;
    try {
      await bounded(reserved.promise);
      pruned = pruner.pruneBuilds(versionId);
      await assertBlocked(await bounded(pruning.promise));
    } finally { release.resolve(); }
    await bounded(reserving);
    assert.deepEqual(await bounded(pruned!), { removed: [E], kept: [A, B, C, D] });
  });

  it('lets prune finish first and refuses activation when later reuse verification finds no artifact', async () => {
    const item = await register();
    const pruning = signal();
    const release = signal();
    const reserving = signal<number>();
    const original = ledger.openReferences.bind(ledger);
    ledger.openReferences = async id => { pruning.resolve(); await release.promise; return original(id); };
    const reservationPool = instrumentPool(async (text, pid, run) => {
      if (text.includes('FROM stack_versions WHERE name = $1 FOR UPDATE')) reserving.resolve(pid);
      return run();
    });
    const pruned = service.pruneBuilds(versionId);
    let reserved: ReturnType<PostgresBundledShipmentRepository['reserveCandidate']> | undefined;
    try {
      await bounded(pruning.promise);
      reserved = new PostgresBundledShipmentRepository(reservationPool, join(root, 'bundled')).reserveCandidate(item.shipmentId, candidate);
      await assertBlocked(await bounded(reserving.promise));
    } finally { release.resolve(); }
    assert.deepEqual(await bounded(pruned), { removed: [A, E], kept: [B, C, D] });
    await bounded(reserved!);
    await shipments.markPrepared(item.shipmentId, { artifactDigest, contract: ALLOCATION_CONTRACT });
    const before = await active();
    await assert.rejects(shipments.activate(item.shipmentId, verifyArtifact), { code: 'ENOENT' });
    assert.deepEqual(await active(), before);
    assert.equal((await shipments.find(item.shipmentId))!.receipt, null);
  });

  it('drops a superseded hold only after resolution and then permits ordinary pruning', async () => {
    const item = await register();
    await shipments.reserveCandidate(item.shipmentId, candidate);
    await shipments.markPrepared(item.shipmentId, { artifactDigest, contract: ALLOCATION_CONTRACT });
    await versions.publish(versionId, { buildId: C, commitSha: C, contract: ALLOCATION_CONTRACT });
    assert.ok((await service.pruneBuilds(versionId)).kept.includes(A));
    assert.equal((await shipments.activate(item.shipmentId, verifyArtifact)).status, 'superseded');
    assert.deepEqual((await service.pruneBuilds(versionId)).removed, [A]);
    assert.equal(existsSync(buildDirFor(root, 'bundled', A)), false);
  });

  it('deletes nothing when the pending shipment read fails', async () => {
    await pool.query('ALTER TABLE bundled_shipments RENAME TO synthetic_unavailable_shipments');
    await assert.rejects(service.pruneBuilds(versionId), /bundled_shipments/);
    for (const id of [A, B, C, D, E]) assert.ok(existsSync(buildDirFor(root, 'bundled', id)));
  });
});
