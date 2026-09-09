import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { ProfileRepository } from '../../src/domain/ProfileRepository.js';
import { deployOwnerOf } from '../../src/domain/versions/buildLedger.js';
import { EventBus } from '../../src/domain/EventBus.js';
import { BundledArtifactMaterializer, bundledMaterializationPath } from '../../src/domain/versions/BundledArtifactMaterializer.js';
import { copyBundledArtifact, verifyBundledArtifact } from '../../src/domain/versions/bundledArtifactFiles.js';
import { bundledArtifactMetadata } from '../../src/domain/versions/bundledArtifactMetadata.js';
import { PostgresBuildLedger } from '../../src/domain/versions/PostgresBuildLedger.js';
import { PostgresBundledShipmentRepository } from '../../src/domain/versions/PostgresBundledShipmentRepository.js';
import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import { StackVersionService } from '../../src/domain/versions/StackVersionService.js';
import { stackRootOf } from '../../src/domain/versions/stackPaths.js';
import { bundledArtifactFixture } from '../support/bundledArtifactFixture.js';

const port = Number(process.env.T04B_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't04b_test', connectionTimeoutMillis: 10000 };
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
function signal() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; }
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('artifact interleaving blocked')), 5000); })]); }
  finally { clearTimeout(timer!); }
}

describe('bundled artifact materialization with isolated PostgreSQL and files', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let root: string;
  let shipments: PostgresBundledShipmentRepository;
  let versions: PostgresStackVersionRepository;
  let materializer: BundledArtifactMaterializer;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 't04b-materializer-'));
    schema = `t04b_materialize_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 10, options: `-c search_path=${schema} -c statement_timeout=10000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    shipments = new PostgresBundledShipmentRepository(pool, join(root, 'bundled'));
    versions = new PostgresStackVersionRepository(pool);
    materializer = new BundledArtifactMaterializer(shipments);
  });
  afterEach(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function fixture(commit = A, buildId = commit) {
    const item = await bundledArtifactFixture(root, { commit });
    const manifest = { ...item.record.candidateManifest!, buildId };
    await shipments.register(item.sealed.identity);
    await shipments.reserveCandidate(item.record.shipmentId, { buildId, kind: 'new', manifest, metadata: bundledArtifactMetadata(manifest) });
    return { ...item, id: item.record.shipmentId };
  }
  async function stored(id: string) { return (await shipments.find(id))!; }
  async function finalPath(id: string) { const row = await stored(id); return stackRootOf({ rootPath: row.rootPath, layout: 'builds', buildId: row.candidateBuildId }); }
  async function activate(id: string) { return shipments.activate(id, async row => { await verifyBundledArtifact(await finalPath(id), row); }); }
  async function publish(commit: string) {
    const item = await fixture(commit);
    await materializer.materialize(item.id, async () => item.sealed);
    await activate(item.id);
    return item;
  }
  const noPackage = async (): Promise<never> => { throw new Error('package must not be read'); };

  function loseCommitAcknowledgement(when: RegExp): Pool {
    let armed = false;
    let lost = false;
    return {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return { release: () => client.release(), query: async (text: string, values?: unknown[]) => {
          const result = await client.query(text, values);
          if (when.test(text)) armed = true;
          if (text === 'COMMIT' && armed && !lost) { lost = true; throw new Error('synthetic acknowledgement loss'); }
          return result;
        } };
      },
    } as unknown as Pool;
  }

  it('installs the selected complete private copy and activates its exact artifact', async () => {
    const item = await fixture();
    assert.equal((await materializer.materialize(item.id, async () => item.sealed)).status, 'prepared');
    const row = await stored(item.id);
    assert.ok(row.materializationId);
    assert.equal(existsSync(bundledMaterializationPath(row)), false);
    assert.equal((await verifyBundledArtifact(await finalPath(item.id), row)).digest, row.artifactDigest);
    assert.equal((await activate(item.id)).status, 'published');
  });

  it('never adopts an unrecorded completed private copy after a crash before preparation', async () => {
    const item = await fixture();
    let abandoned = '';
    const crashing = new BundledArtifactMaterializer(shipments, { copy: async (...args) => {
      await copyBundledArtifact(...args); abandoned = args[1]; throw new Error('crash after copy');
    } });
    await assert.rejects(crashing.materialize(item.id, async () => item.sealed), /crash after copy/);
    assert.equal((await stored(item.id)).state, 'registered');
    assert.ok(existsSync(abandoned));
    await materializer.materialize(item.id, async () => item.sealed);
    assert.notEqual(bundledMaterializationPath(await stored(item.id)), abandoned);
    assert.ok(existsSync(abandoned));
  });

  it('retains and replays the selected copy after preparation commits but its reply is lost', async () => {
    const item = await fixture();
    const uncertain = new PostgresBundledShipmentRepository(loseCommitAcknowledgement(/^UPDATE bundled_shipments SET state = 'prepared'/), join(root, 'bundled'));
    await assert.rejects(new BundledArtifactMaterializer(uncertain).materialize(item.id, async () => item.sealed), /acknowledgement loss/);
    const selected = await stored(item.id);
    assert.equal(selected.state, 'prepared');
    assert.ok(existsSync(bundledMaterializationPath(selected)));
    assert.equal((await materializer.materialize(item.id, noPackage)).status, 'prepared');
    assert.equal((await stored(item.id)).materializationId, selected.materializationId);
  });

  it('recovers a crash after preparation without loading or recopying the package', async () => {
    const item = await fixture();
    const crashing = new BundledArtifactMaterializer(shipments, { verify: async () => { throw new Error('crash before install'); } });
    await assert.rejects(crashing.materialize(item.id, async () => item.sealed), /crash before install/);
    const selected = await stored(item.id);
    assert.ok(existsSync(bundledMaterializationPath(selected)));
    await materializer.materialize(item.id, noPackage);
    assert.equal((await stored(item.id)).materializationId, selected.materializationId);
  });

  it('refuses a missing selected copy and missing final path without selecting a replacement', async () => {
    const item = await fixture();
    const crashing = new BundledArtifactMaterializer(shipments, { verify: async () => { throw new Error('pause prepared'); } });
    await assert.rejects(crashing.materialize(item.id, async () => item.sealed), /pause prepared/);
    const before = await stored(item.id);
    await rm(bundledMaterializationPath(before), { recursive: true });
    await assert.rejects(materializer.materialize(item.id, noPackage), /missing|ENOENT/i);
    assert.deepEqual(await stored(item.id), before);
    assert.equal(existsSync(await finalPath(item.id)), false);
  });

  it('recovers an installed artifact when rename succeeded before an acknowledgement failure', async () => {
    const item = await fixture();
    const uncertain = new BundledArtifactMaterializer(shipments, { rename: async (source, destination) => { await rename(source, destination); throw new Error('rename acknowledgement loss'); } });
    await assert.rejects(uncertain.materialize(item.id, async () => item.sealed), /rename acknowledgement loss/);
    const path = await finalPath(item.id);
    const before = await lstat(path);
    assert.equal(existsSync(bundledMaterializationPath(await stored(item.id))), false);
    await materializer.materialize(item.id, noPackage);
    assert.equal((await lstat(path)).ino, before.ino);
  });

  for (const occupied of ['empty', 'nonempty', 'file'] as const) {
    it(`never replaces an existing ${occupied} final destination`, async () => {
      const item = await fixture();
      const path = await finalPath(item.id);
      await mkdir(join(root, 'bundled.builds'), { recursive: true });
      if (occupied === 'file') await writeFile(path, 'keep');
      else { await mkdir(path); if (occupied === 'nonempty') await writeFile(join(path, 'sentinel'), 'keep'); }
      const before = await lstat(path);
      await assert.rejects(materializer.materialize(item.id, async () => item.sealed));
      assert.equal((await lstat(path)).ino, before.ino);
      assert.ok(existsSync(bundledMaterializationPath(await stored(item.id))));
      if (occupied !== 'empty') assert.equal(await readFile(occupied === 'file' ? path : join(path, 'sentinel'), 'utf8'), 'keep');
    });
  }

  it('does not overwrite an empty destination appearing after private-copy verification', async () => {
    const item = await fixture();
    const path = await finalPath(item.id);
    let occupiedInode: number | null = null;
    let renames = 0;
    const racing = new BundledArtifactMaterializer(shipments, {
      verify: async (...args) => {
        const result = await verifyBundledArtifact(...args);
        if (occupiedInode === null) { await mkdir(path); occupiedInode = (await lstat(path)).ino; }
        return result;
      },
      rename: async (source, destination) => { renames += 1; await rename(source, destination); },
    });
    await assert.rejects(racing.materialize(item.id, async () => item.sealed));
    assert.notEqual(occupiedInode, null);
    assert.equal((await lstat(path)).ino, occupiedInode);
    assert.equal(renames, 0);
    assert.ok(existsSync(bundledMaterializationPath(await stored(item.id))));
  });

  it('converges duplicate callers onto one durable copy and one final artifact', async () => {
    const item = await fixture();
    const both = signal();
    let copies = 0;
    const concurrent = new BundledArtifactMaterializer(shipments, { copy: async (...args) => {
      const result = await copyBundledArtifact(...args);
      if (++copies === 2) both.resolve();
      await bounded(both.promise);
      return result;
    } });
    const results = await bounded(Promise.all([concurrent.materialize(item.id, async () => item.sealed), concurrent.materialize(item.id, async () => item.sealed)]));
    assert.deepEqual(results.map(result => result.status), ['prepared', 'prepared']);
    assert.equal(copies, 2);
    const row = await stored(item.id);
    await verifyBundledArtifact(await finalPath(item.id), row);
    assert.equal(existsSync(bundledMaterializationPath(row)), false);
  });

  it('does not block deployment admission during verification and cannot install stale A after C wins', async () => {
    await publish(B);
    const selected = (await versions.findByName('bundled'))!;
    const item = await fixture(A);
    const entered = signal();
    const release = signal();
    const waiting = new BundledArtifactMaterializer(shipments, { verify: async (...args) => { entered.resolve(); await release.promise; return verifyBundledArtifact(...args); } });
    const operation = waiting.materialize(item.id, async () => item.sealed);
    try {
      await bounded(entered.promise);
      const ledger = new PostgresBuildLedger(pool, { mountedRootOf: async () => { throw new Error('no Docker'); } }, root);
      await pool.query("INSERT INTO profiles (name, kind, port_slot, status, stack_version_id) VALUES ('synthetic-profile', 'streamer', 1, 'DEPLOYING', $1)", [selected.id]);
      const owner = deployOwnerOf((await new ProfileRepository(pool).findByName('synthetic-profile'))!);
      assert.ok((await bounded(ledger.describe('synthetic-profile', selected, ['srs'], owner))).referenceId);
      await bounded(publish(C));
    } finally { release.resolve(); }
    assert.equal((await bounded(operation)).status, 'superseded');
    assert.equal((await versions.findByName('bundled'))!.buildId, C);
    assert.equal(existsSync(await finalPath(item.id)), false);
  });

  it('returns the stored A receipt after lost activation acknowledgement and B/C publication without package or artifact reads', async () => {
    const item = await fixture(A);
    await materializer.materialize(item.id, async () => item.sealed);
    const uncertain = new PostgresBundledShipmentRepository(loseCommitAcknowledgement(/^UPDATE bundled_shipments SET state = 'published'/), join(root, 'bundled'));
    await assert.rejects(uncertain.activate(item.id, async row => { await verifyBundledArtifact(await finalPath(item.id), row); }), /acknowledgement loss/);
    const receipt = (await stored(item.id)).receipt;
    await publish(B);
    await publish(C);
    await rm(await finalPath(item.id), { recursive: true });
    const replay = new BundledArtifactMaterializer(shipments, { verify: async () => { throw new Error('artifact must not be read'); }, copy: async () => { throw new Error('copy must not run'); } });
    const result = await replay.materialize(item.id, noPackage);
    assert.equal(result.status, 'published');
    if (result.status === 'published') assert.deepEqual(result.receipt, receipt);
    assert.equal((await versions.findByName('bundled'))!.buildId, C);
  });

  it('recovers A receipt when another caller publishes A and B/C prune its files during verification', async () => {
    const item = await fixture(A);
    await materializer.materialize(item.id, async () => item.sealed);
    const entered = signal();
    const release = signal();
    const waiting = new BundledArtifactMaterializer(shipments, { verify: async (...args) => { entered.resolve(); await release.promise; return verifyBundledArtifact(...args); } });
    const operation = waiting.materialize(item.id, noPackage);
    try {
      await bounded(entered.promise);
      await activate(item.id);
      await publish(B);
      await publish(C);
      const ledger = new PostgresBuildLedger(pool, { mountedRootOf: async () => { throw new Error('no Docker'); } }, root);
      const pruner = new StackVersionService(versions, { run: () => { throw new Error('no build'); } }, new EventBus(), root, ledger);
      assert.ok((await pruner.pruneBuilds((await stored(item.id)).versionId)).removed.includes(A));
    } finally { release.resolve(); }
    const result = await bounded(operation);
    assert.equal(result.status, 'published');
    assert.equal((await versions.findByName('bundled'))!.buildId, C);
  });

  it('reuses recorded bytes after complete input comparison despite a different incoming generation', async () => {
    const origin = await publish(A);
    const original = await stored(origin.id);
    const item = await bundledArtifactFixture(root, { commit: A, advanceGeneration: true });
    assert.notEqual(item.record.candidateManifest!.inputGeneration, original.candidateManifest!.inputGeneration);
    assert.deepEqual(item.record.candidateManifest!.inputHashes, original.candidateManifest!.inputHashes);
    await shipments.register(item.sealed.identity);
    await shipments.reserveCandidate(item.record.shipmentId, { buildId: A, kind: 'reuse', manifest: original.candidateManifest!, metadata: original.candidateMetadata! });
    const path = await finalPath(origin.id);
    const before = await lstat(path);
    const result = await materializer.materialize(item.record.shipmentId, async () => item.sealed, { reuseFromShipmentId: origin.id });
    assert.equal(result.status, 'prepared');
    assert.equal((await stored(item.record.shipmentId)).artifactDigest, original.artifactDigest);
    assert.equal((await lstat(path)).ino, before.ino);
    assert.equal((await activate(item.record.shipmentId)).status, 'published');
  });

  it('never advertises reuse when any incoming input differs from the recorded artifact', async () => {
    const origin = await publish(A);
    const original = await stored(origin.id);
    const item = await bundledArtifactFixture(root, { commit: A, input: 'changed' });
    await shipments.register(item.sealed.identity);
    await shipments.reserveCandidate(item.record.shipmentId, { buildId: A, kind: 'reuse', manifest: original.candidateManifest!, metadata: original.candidateMetadata! });
    await assert.rejects(materializer.materialize(item.record.shipmentId, async () => item.sealed, { reuseFromShipmentId: origin.id }), /input/i);
    assert.equal((await stored(item.record.shipmentId)).state, 'registered');
    assert.equal((await stored(item.record.shipmentId)).artifactDigest, null);
  });

  it('preserves a pre-journal artifact and materializes a new verified artifact instead of inferring reuse', async () => {
    const legacy = join(root, 'bundled.builds', A);
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, '.stack-manifest.json'), JSON.stringify({ commit: A, buildId: A, inputGeneration: 1 }));
    await writeFile(join(legacy, '.complete'), '');
    const before = await readFile(join(legacy, '.stack-manifest.json'));
    const item = await fixture(A, `${A}-r1`);
    await materializer.materialize(item.id, async () => item.sealed);
    assert.deepEqual(await readFile(join(legacy, '.stack-manifest.json')), before);
    assert.notEqual(await finalPath(item.id), legacy);
    assert.equal((await activate(item.id)).status, 'published');
  });

  it('does not advertise a pre-journal artifact as reused without recorded byte provenance', async () => {
    const item = await bundledArtifactFixture(root);
    await shipments.register(item.sealed.identity);
    await shipments.reserveCandidate(item.record.shipmentId, { buildId: A, kind: 'reuse', manifest: item.record.candidateManifest!, metadata: item.record.candidateMetadata! });
    await assert.rejects(materializer.materialize(item.record.shipmentId, async () => item.sealed, { reuseFromShipmentId: randomUUID() }), /provenance/i);
    assert.equal((await stored(item.record.shipmentId)).state, 'registered');
    assert.equal((await stored(item.record.shipmentId)).artifactDigest, null);
  });
});
