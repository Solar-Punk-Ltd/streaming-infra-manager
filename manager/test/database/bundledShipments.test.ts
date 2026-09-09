import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { PostgresBundledShipmentRepository } from '../../src/domain/versions/PostgresBundledShipmentRepository.js';
import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import type { BundledShipmentIdentity } from '../../src/domain/versions/bundledShipmentPackage.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

const port = Number(process.env.T04B_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't04b_test', connectionTimeoutMillis: 10000 };
const A = 'a'.repeat(40);
const C = 'c'.repeat(40);
const artifactDigest = 'e'.repeat(64);
function identity(commit = A): BundledShipmentIdentity { return { shipmentId: randomUUID(), commit, digest: randomBytes(32).toString('hex') }; }
function proposal(commit = A, kind: 'new' | 'reuse' = 'new') {
  return {
    buildId: commit,
    kind,
    manifest: { commit, buildId: commit, builtAt: '2026-09-09T00:00:00.000Z', toolchain: 'synthetic', inputGeneration: 1, inputHashes: {} },
  };
}
function gate() {
  let release!: () => void;
  let entered!: () => void;
  return { waiting: new Promise<void>(resolve => { release = resolve; }), started: new Promise<void>(resolve => { entered = resolve; }), release: () => release(), enter: () => entered() };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('independent operation was blocked by artifact verification')), 5000); })]);
  } finally { clearTimeout(timer!); }
}

describe('bundled shipment journal in isolated PostgreSQL', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let versions: PostgresStackVersionRepository;
  let shipments: PostgresBundledShipmentRepository;
  let versionId: number;
  beforeEach(async () => {
    schema = `t04b_shipment_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 8, options: `-c search_path=${schema} -c statement_timeout=10000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    }
    versions = new PostgresStackVersionRepository(pool);
    shipments = new PostgresBundledShipmentRepository(pool, '/synthetic/bundled');
    versionId = (await versions.findByName('bundled'))!.id;
  });
  afterEach(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });
  async function prepare(item = identity()) {
    await shipments.register(item);
    await shipments.reserveCandidate(item.shipmentId, proposal(item.commit));
    await shipments.markPrepared(item.shipmentId, { artifactDigest, contract: ALLOCATION_CONTRACT, materializationId: randomUUID() });
    return item;
  }
  async function active() {
    return (await pool.query('SELECT build_id, commit_sha, root_path, previous_build_id, tested, publication_revision FROM stack_versions WHERE id = $1', [versionId])).rows[0]!;
  }

  it('dates journal publication invalidation and replays an old receipt without changing newer approval', async () => {
    await versions.publish(versionId, { buildId: A, commitSha: A, rootPath: '/synthetic/bundled', contract: ALLOCATION_CONTRACT });
    await versions.setTested(versionId, true, A, A);
    const rebuild = identity(A);
    const buildId = `${A}-r1`;
    const candidate = proposal(A);
    await shipments.register(rebuild);
    await shipments.reserveCandidate(rebuild.shipmentId, {
      ...candidate, buildId, manifest: { ...candidate.manifest, buildId },
    });
    await shipments.markPrepared(rebuild.shipmentId, { artifactDigest, contract: ALLOCATION_CONTRACT, materializationId: randomUUID() });
    const receipt = await shipments.activate(rebuild.shipmentId, async () => {});
    assert.equal(receipt.status, 'published');
    const first = (await versions.findById(versionId))!;
    assert.equal(first.commitSha, A);
    assert.equal(first.buildId, buildId);
    assert.equal(first.tested, false);
    assert.ok(first.testedInvalidatedAt instanceof Date);
    assert.equal(first.isDefault, true);

    const later = await prepare(identity(C));
    assert.equal((await shipments.activate(later.shipmentId, async () => {})).status, 'published');
    assert.deepEqual((await versions.findById(versionId))!.testedInvalidatedAt, first.testedInvalidatedAt);
    await versions.setTested(versionId, true, C, C);
    const approved = (await pool.query('SELECT * FROM stack_versions WHERE id = $1', [versionId])).rows[0]!;
    assert.equal(approved.tested, true);
    assert.equal(approved.tested_invalidated_at, null);
    assert.equal(approved.is_default, true);
    assert.deepEqual(await shipments.activate(rebuild.shipmentId, async () => assert.fail('receipt replay must not verify files')), receipt);
    assert.deepEqual((await pool.query('SELECT * FROM stack_versions WHERE id = $1', [versionId])).rows[0], approved);
  });

  it('registers once and preserves the original expected revision across identical replay after C', async () => {
    const item = identity();
    const first = await shipments.register(item);
    assert.equal(first.expectedRevision, '0');
    await versions.publish(versionId, { buildId: C, commitSha: C, rootPath: '/synthetic/bundled', contract: ALLOCATION_CONTRACT });
    assert.deepEqual(await shipments.register(item), first);
    await assert.rejects(shipments.register({ ...item, digest: '0'.repeat(64) }), /identity/i);
    await assert.rejects(shipments.register({ ...item, commit: C }), /identity/i);
    assert.deepEqual(await shipments.find(item.shipmentId), first);
  });

  it('records candidate identity before preparation and refuses candidate or digest reassignment', async () => {
    const item = identity();
    await shipments.register(item);
    const selected = await shipments.reserveCandidate(item.shipmentId, proposal());
    assert.equal(selected.state, 'registered');
    assert.equal(selected.candidateBuildId, A);
    assert.equal(selected.artifactDigest, null);
    assert.deepEqual(await shipments.pendingBuildIds(versionId), [A]);
    assert.deepEqual(await shipments.reserveCandidate(item.shipmentId, proposal()), selected);
    await assert.rejects(shipments.reserveCandidate(item.shipmentId, { ...proposal(), buildId: `${A}-r1`, manifest: { ...proposal().manifest, buildId: `${A}-r1` } }), /candidate/i);
    const prepared = await shipments.markPrepared(item.shipmentId, { artifactDigest, contract: ALLOCATION_CONTRACT, materializationId: randomUUID() });
    assert.equal(prepared.state, 'prepared');
    assert.deepEqual(await shipments.markPrepared(item.shipmentId, { artifactDigest, contract: ALLOCATION_CONTRACT, materializationId: randomUUID() }), prepared);
    await assert.rejects(shipments.markPrepared(item.shipmentId, { artifactDigest: 'f'.repeat(64), contract: ALLOCATION_CONTRACT, materializationId: randomUUID() }), /prepared|digest/i);
  });

  it('persists exact generated metadata bytes before a candidate is materialized', async () => {
    const item = identity();
    await shipments.register(item);
    const selected = proposal();
    const metadata = { manifestBytes: JSON.stringify(selected.manifest) + '\n', manifestMode: 0o644, completeBytes: '', completeMode: 0o644 };
    const reserved = await shipments.reserveCandidate(item.shipmentId, { ...selected, metadata });
    assert.deepEqual(reserved.candidateMetadata, metadata);
    assert.deepEqual((await shipments.find(item.shipmentId))!.candidateMetadata, metadata);
    await assert.rejects(shipments.reserveCandidate(item.shipmentId, { ...selected, metadata: { ...metadata, manifestBytes: JSON.stringify(selected.manifest, null, 2) + '\n' } }), /candidate/i);
    await assert.rejects(pool.query("UPDATE bundled_shipments SET candidate_metadata = jsonb_set(candidate_metadata, '{completeBytes}', '\"changed\"') WHERE shipment_id = $1", [item.shipmentId]), /candidate|check/i);
  });

  it('refuses metadata whose parsed identity differs from the reserved manifest', async () => {
    const item = identity();
    await shipments.register(item);
    const metadata = { manifestBytes: JSON.stringify(proposal(C).manifest), manifestMode: 0o644, completeBytes: '', completeMode: 0o644 };
    await assert.rejects(shipments.reserveCandidate(item.shipmentId, { ...proposal(), metadata }), /metadata|manifest/i);
    assert.equal((await shipments.find(item.shipmentId))!.candidateBuildId, null);
  });

  it('selects one completed private copy and preserves it across duplicate preparation and restart', async () => {
    const item = identity();
    await shipments.register(item);
    await shipments.reserveCandidate(item.shipmentId, proposal());
    const copies: string[] = [randomUUID(), randomUUID()];
    const outcomes = await Promise.all(copies.map(materializationId => shipments.markPrepared(item.shipmentId, { artifactDigest, contract: ALLOCATION_CONTRACT, materializationId })));
    assert.ok(copies.includes(outcomes[0]!.materializationId!));
    assert.equal(outcomes[1]!.materializationId, outcomes[0]!.materializationId);
    const restarted = new PostgresBundledShipmentRepository(pool, '/synthetic/bundled');
    assert.equal((await restarted.find(item.shipmentId))!.materializationId, outcomes[0]!.materializationId);
    await assert.rejects(pool.query('UPDATE bundled_shipments SET materialization_id = $2 WHERE shipment_id = $1', [item.shipmentId, randomUUID()]), /prepared|identity/i);
  });

  it('requires a private copy for new artifacts and forbids claiming a copy for reuse', async () => {
    for (const kind of ['new', 'reuse'] as const) {
      const item = identity();
      await shipments.register(item);
      await shipments.reserveCandidate(item.shipmentId, proposal(A, kind));
      await assert.rejects(shipments.markPrepared(item.shipmentId, { artifactDigest, contract: ALLOCATION_CONTRACT, materializationId: kind === 'new' ? null : randomUUID() }), /copy|materialization/i);
      assert.equal((await shipments.find(item.shipmentId))!.state, 'registered');
    }
  });

  it('prevents duplicate new candidate ownership but records explicit reuse separately', async () => {
    const first = identity();
    const second = identity();
    await shipments.register(first);
    await shipments.register(second);
    await shipments.reserveCandidate(first.shipmentId, proposal());
    await assert.rejects(shipments.reserveCandidate(second.shipmentId, proposal()), /reserved|candidate/i);
    assert.equal((await shipments.find(second.shipmentId))!.candidateBuildId, null);
    const reused = await shipments.reserveCandidate(second.shipmentId, proposal(A, 'reuse'));
    assert.equal(reused.candidateKind, 'reuse');
    assert.deepEqual(await shipments.pendingBuildIds(versionId), [A]);
  });

  it('refuses a new materializer when an earlier reservation owns the id as reuse', async () => {
    const first = identity();
    const second = identity();
    await shipments.register(first);
    await shipments.register(second);
    await shipments.reserveCandidate(first.shipmentId, proposal(A, 'reuse'));
    await assert.rejects(shipments.reserveCandidate(second.shipmentId, proposal()), /reserved|candidate/i);
    assert.equal((await shipments.find(second.shipmentId))!.candidateBuildId, null);
    assert.equal((await shipments.find(first.shipmentId))!.candidateKind, 'reuse');
  });

  it('supersedes already-stale A before asking for artifact verification', async () => {
    const item = await prepare();
    await versions.publish(versionId, { buildId: C, commitSha: C, rootPath: '/synthetic/bundled', contract: ALLOCATION_CONTRACT });
    const before = await active();
    let verifications = 0;
    const result = await shipments.activate(item.shipmentId, async () => {
      verifications += 1;
      throw new Error('stale candidate need not be read');
    });
    assert.equal(result.status, 'superseded');
    assert.equal(verifications, 0);
    assert.deepEqual(await active(), before);
    assert.deepEqual(await shipments.pendingBuildIds(versionId), []);
  });

  it('preserves its registered root and database identity against retries and direct reassignment', async () => {
    const item = await prepare();
    const original = (await shipments.find(item.shipmentId))!;
    const alternate = new PostgresBundledShipmentRepository(pool, '/synthetic/alternate');
    assert.deepEqual(await alternate.register(item), original);
    for (const update of [
      "expected_publication_revision = 7",
      "root_path = '/synthetic/alternate'",
      "artifact_digest = repeat('0', 64)",
      "state = 'registered', artifact_digest = NULL, candidate_contract = NULL",
    ]) {
      await assert.rejects(pool.query(`UPDATE bundled_shipments SET ${update} WHERE shipment_id = $1`, [item.shipmentId]), /identity|prepared|candidate/i);
      assert.deepEqual(await shipments.find(item.shipmentId), original);
    }
  });

  it('lets only one of two prepared shipments at one revision activate', async () => {
    const first = await prepare(identity());
    const second = await prepare(identity(C));
    const outcomes = await Promise.all([
      shipments.activate(first.shipmentId, async () => {}),
      shipments.activate(second.shipmentId, async () => {}),
    ]);
    assert.deepEqual(outcomes.map(result => result.status).sort(), ['published', 'superseded']);
    assert.equal((await active()).publication_revision, '1');
    assert.deepEqual(await shipments.pendingBuildIds(versionId), []);
  });

  it('replays A’s durable receipt after C without verifying or republishing a pruned A', async () => {
    const first = await prepare();
    const receipt = await shipments.activate(first.shipmentId, async () => {});
    const next = await prepare(identity(C));
    await shipments.activate(next.shipmentId, async () => {});
    const before = await active();
    const replay = await new PostgresBundledShipmentRepository(pool, '/synthetic/bundled').activate(first.shipmentId, async () => { throw new Error('A was pruned'); });
    assert.deepEqual(replay, receipt);
    assert.deepEqual(await active(), before);
    assert.equal(before.build_id, C);
  });

  it('rolls back active publication and receipt together when receipt storage fails', async () => {
    const item = await prepare();
    const before = await active();
    await pool.query("ALTER TABLE bundled_shipments ADD CONSTRAINT synthetic_receipt_failure CHECK (state <> 'published')");
    await assert.rejects(shipments.activate(item.shipmentId, async () => {}), /synthetic_receipt_failure/);
    assert.deepEqual(await active(), before);
    assert.equal((await shipments.find(item.shipmentId))!.state, 'prepared');
    assert.equal((await shipments.find(item.shipmentId))!.receipt, null);
    await pool.query('ALTER TABLE bundled_shipments DROP CONSTRAINT synthetic_receipt_failure');
    assert.equal((await shipments.activate(item.shipmentId, async () => {})).status, 'published');
  });

  it('recovers lost commit acknowledgement through a new repository after a later publication', async () => {
    const item = await prepare();
    let loseReply = true;
    const lostAckPool = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return {
          release: () => client.release(),
          query: async (text: string, values?: unknown[]) => {
            const result = await client.query(text, values);
            if (text === 'COMMIT' && loseReply) { loseReply = false; throw new Error('synthetic acknowledgement loss'); }
            return result;
          },
        };
      },
    } as unknown as Pool;
    await assert.rejects(new PostgresBundledShipmentRepository(lostAckPool, '/synthetic/bundled').activate(item.shipmentId, async () => {}), /acknowledgement loss/);
    assert.equal((await active()).build_id, A);
    const original = (await shipments.find(item.shipmentId))!.receipt;
    assert.ok(original);
    const next = await prepare(identity(C));
    await shipments.activate(next.shipmentId, async () => {});
    const replay = await shipments.activate(item.shipmentId, async () => { throw new Error('A no longer exists'); });
    assert.equal(replay.status, 'published');
    if (replay.status === 'published') assert.deepEqual(replay.receipt, original);
    assert.equal((await active()).build_id, C);
  });

  it('keeps verification outside the row lock and supersedes A when C wins during it', async () => {
    const item = await prepare();
    const barrier = gate();
    const pending = shipments.activate(item.shipmentId, async () => { barrier.enter(); await barrier.waiting; });
    await barrier.started;
    try {
      await bounded(pool.query('SELECT id FROM stack_versions WHERE id = $1 FOR SHARE', [versionId]));
      const next = identity(C);
      await bounded(shipments.register(next));
      await shipments.reserveCandidate(next.shipmentId, proposal(C));
      await shipments.markPrepared(next.shipmentId, { artifactDigest, contract: ALLOCATION_CONTRACT, materializationId: randomUUID() });
      await shipments.activate(next.shipmentId, async () => {});
      assert.deepEqual(await shipments.pendingBuildIds(versionId), [A]);
    } finally { barrier.release(); }
    assert.equal((await pending).status, 'superseded');
    assert.equal((await active()).build_id, C);
    assert.deepEqual(await shipments.pendingBuildIds(versionId), []);
  });

  it('returns the existing A receipt if a second verifier fails after A and then C published', async () => {
    const item = await prepare();
    const barrier = gate();
    const second = shipments.activate(item.shipmentId, async () => {
      barrier.enter();
      await barrier.waiting;
      throw new Error('A disappeared after C pruned it');
    });
    await barrier.started;
    let receipt;
    try {
      receipt = await shipments.activate(item.shipmentId, async () => {});
      const next = await prepare(identity(C));
      await shipments.activate(next.shipmentId, async () => {});
    } finally { barrier.release(); }
    assert.deepEqual(await second, receipt);
    assert.equal((await active()).build_id, C);
    assert.equal((await active()).publication_revision, '2');
  });

  it('retains the pending candidate and never activates when verification fails without a receipt', async () => {
    const item = await prepare();
    const before = await active();
    await assert.rejects(shipments.activate(item.shipmentId, async () => { throw new Error('synthetic artifact mismatch'); }), /artifact mismatch/);
    assert.deepEqual(await active(), before);
    assert.equal((await shipments.find(item.shipmentId))!.state, 'prepared');
    assert.deepEqual(await shipments.pendingBuildIds(versionId), [A]);
  });

  it('refuses activation of an unregistered artifact without consulting a filesystem verifier', async () => {
    const before = await active();
    let reads = 0;
    await assert.rejects(shipments.activate(randomUUID(), async () => { reads += 1; }), /shipment.*not found/i);
    assert.equal(reads, 0);
    assert.deepEqual(await active(), before);
  });

  it('never applies an older version row’s shipment to a replacement bundled row', async () => {
    const item = await prepare();
    await pool.query("UPDATE stack_versions SET name = 'retired-bundled' WHERE id = $1", [versionId]);
    const replacement = await versions.insert({ name: 'bundled', gitRef: 'synthetic', rootPath: '/synthetic/replacement' });
    const before = await versions.findById(replacement.id);
    await assert.rejects(shipments.activate(item.shipmentId, async () => {}), /identity|version/i);
    assert.deepEqual(await versions.findById(replacement.id), before);
    assert.equal((await shipments.find(item.shipmentId))!.receipt, null);
  });
});
