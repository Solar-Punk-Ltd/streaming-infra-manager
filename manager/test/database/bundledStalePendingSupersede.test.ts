/**
 * What a publication does to the shipments it has left behind: a shipment
 * registered or prepared against an older publication can never activate, and
 * saying so in the journal is what lets the package sweep remove its files.
 *
 * Gated on T04B_TEST_PG_PORT, like its neighbours. Start a throwaway Postgres
 * on the machine running the tests and point that variable at its port.
 */
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
const COMMIT = 'a'.repeat(40);
const ARTIFACT_DIGEST = 'e'.repeat(64);
const ROOT_PATH = '/synthetic/bundled';

function identity(): BundledShipmentIdentity {
  return { shipmentId: randomUUID(), commit: COMMIT, digest: randomBytes(32).toString('hex') };
}
function proposal(buildId: string) {
  return {
    buildId,
    kind: 'new' as const,
    manifest: { commit: COMMIT, buildId, builtAt: '2026-09-09T00:00:00.000Z', toolchain: 'synthetic', inputGeneration: 1, inputHashes: {} },
  };
}

describe('superseding the shipments a publication left behind', {
  skip: !Number.isInteger(port) || port < 1 || port > 65535, timeout: 60000,
}, () => {
  let admin: Pool; let pool: Pool; let schema: string;
  let versions: PostgresStackVersionRepository; let shipments: PostgresBundledShipmentRepository; let versionId: number;

  beforeEach(async () => {
    schema = `t04b_stale_pending_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, options: `-c search_path=${schema} -c statement_timeout=10000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    }
    versions = new PostgresStackVersionRepository(pool);
    shipments = new PostgresBundledShipmentRepository(pool, ROOT_PATH);
    versionId = (await versions.findByName('bundled'))!.id;
  });
  afterEach(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  async function registered(): Promise<BundledShipmentIdentity> {
    const item = identity();
    await shipments.register(item);
    return item;
  }
  async function prepared(buildId: string): Promise<{ item: BundledShipmentIdentity; materializationId: string }> {
    const item = await registered();
    const materializationId = randomUUID();
    await shipments.reserveCandidate(item.shipmentId, proposal(buildId));
    await shipments.markPrepared(item.shipmentId, { artifactDigest: ARTIFACT_DIGEST, contract: ALLOCATION_CONTRACT, materializationId });
    return { item, materializationId };
  }
  async function publish(buildId: string): Promise<void> {
    await versions.publish(versionId, { buildId, commitSha: COMMIT, rootPath: ROOT_PATH, contract: ALLOCATION_CONTRACT });
  }

  it('supersedes exactly the shipments an older publication left, and the identity trigger takes the change', async () => {
    const stalePrepared = await prepared(`${COMMIT}-r1`);
    const staleRegistered = await registered();
    await publish(`${COMMIT}-r9`);
    const current = await registered();

    const changed = await shipments.supersedeStalePending(versionId);

    assert.deepEqual(changed.map(record => record.shipmentId).sort(),
      [stalePrepared.item.shipmentId, staleRegistered.shipmentId].sort());
    assert.deepEqual(changed.map(record => record.state), ['superseded', 'superseded']);
    for (const item of [stalePrepared.item, staleRegistered]) {
      assert.equal((await shipments.find(item.shipmentId))!.state, 'superseded');
    }
    assert.equal((await shipments.find(current.shipmentId))!.state, 'registered', 'a shipment at the current revision is still live');
  });

  it('leaves the shipment that is the current publication alone', async () => {
    const winner = await prepared(`${COMMIT}-r2`);
    const activation = await shipments.activate(winner.item.shipmentId, async () => {});
    assert.equal(activation.status, 'published');
    const before = await shipments.find(winner.item.shipmentId);

    assert.deepEqual(await shipments.supersedeStalePending(versionId), []);

    assert.deepEqual(await shipments.find(winner.item.shipmentId), before);
  });

  it('changes nothing on a second sweep of the same publication', async () => {
    await prepared(`${COMMIT}-r3`);
    await publish(`${COMMIT}-r8`);
    assert.equal((await shipments.supersedeStalePending(versionId)).length, 1);

    assert.deepEqual(await shipments.supersedeStalePending(versionId), []);
  });

  it('finds the shipment a private copy belongs to, so the sweep knows whose it is', async () => {
    const stale = await prepared(`${COMMIT}-r4`);
    await publish(`${COMMIT}-r7`);
    await shipments.supersedeStalePending(versionId);

    const owner = await shipments.findByMaterialization(stale.materializationId);

    assert.equal(owner?.shipmentId, stale.item.shipmentId);
    assert.equal(owner?.state, 'superseded');
    assert.equal(owner?.candidateKind, 'new');
    assert.equal(await shipments.findByMaterialization(randomUUID()), null, 'a copy the journal never recorded belongs to nobody');
  });
});
