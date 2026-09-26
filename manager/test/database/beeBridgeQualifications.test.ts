/**
 * The manager's own record of the Bee images it checked, in a real PostgreSQL.
 *
 * A pass qualifies exactly its tuple under the check that made it. Failures are
 * history: every attempt is kept and none of them qualifies anything. Two first
 * transfers racing on a new tuple both check, and one pass row lands, which the
 * partial unique index on passes makes true where the application cannot.
 *
 * It needs a disposable PostgreSQL on T09_TEST_PG_PORT, and skips without it.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { BEE_BRIDGE_CHECK_REVISION, beeBridgeCheckEvidence, beeBridgeCheckVerdict } from '../../src/domain/chequebook/beeBridgeCheck.js';
import type { BeeBridgeTuple } from '../../src/domain/chequebook/beeBridgeQualification.js';
import { createBeeBridgeQualifier } from '../../src/domain/chequebook/beeBridgeQualification.js';
import { DOCKER_BEE_BRIDGE_REVISION } from '../../src/domain/chequebook/dockerBeeBridge.js';
import { DOCKER_BEE_STREAM_BOUNDS } from '../../src/domain/chequebook/beeBridgeQualification.js';
import { PostgresBeeBridgeQualifications } from '../../src/domain/chequebook/PostgresBeeBridgeQualifications.js';
import { syntheticBeeBridgeCheckAnswer } from '../support/beeBridgeCheckAnswer.js';

const port = Number(process.env.T09_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't09_test', connectionTimeoutMillis: 30000 };
const tuple = (): BeeBridgeTuple => ({ imageId: `sha256:${'d'.repeat(64)}`, engineVersion: '29.1.3',
  platform: { os: 'linux', architecture: 'amd64', variant: '' }, bridgeRevision: DOCKER_BEE_BRIDGE_REVISION });
const checked = (answer = syntheticBeeBridgeCheckAnswer(), at = tuple(), hostAlias = 'bee-eu-1') => {
  const verdict = beeBridgeCheckVerdict(answer);
  return { tuple: at, failedCheck: verdict.failed, evidence: beeBridgeCheckEvidence(at, verdict), hostAlias };
};

describe('stored Bee bridge qualifications in isolated PostgreSQL schemas', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let store: PostgresBeeBridgeQualifications;
  beforeEach(async () => {
    schema = `t09q_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 10, options: `-c search_path=${schema}` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    }
    store = new PostgresBeeBridgeQualifications(pool);
  });
  afterEach(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  const rows = async () => (await pool.query<{ outcome: string; failed_check: string | null; host_alias: string; harness_revision: string; evidence_digest: string }>(
    'SELECT outcome, failed_check, host_alias, harness_revision, evidence_digest FROM bee_bridge_qualifications ORDER BY id')).rows;

  it('stores a pass with its evidence, digest, check revision and first host, and reads it back for exactly that tuple', async () => {
    const pass = checked();
    await store.record(pass);
    const [row] = await rows();
    assert.deepEqual(row, { outcome: 'passed', failed_check: null, host_alias: 'bee-eu-1', harness_revision: BEE_BRIDGE_CHECK_REVISION, evidence_digest: pass.evidence.digest });
    const evidence = (await pool.query<{ evidence: unknown }>('SELECT evidence FROM bee_bridge_qualifications')).rows[0]!.evidence;
    assert.deepEqual(evidence, pass.evidence.evidence);
    const record = await store.passFor(tuple());
    assert.ok(record);
    assert.equal(record.harnessRevision, BEE_BRIDGE_CHECK_REVISION);
    assert.equal(record.evidenceDigest, pass.evidence.digest);
    assert.equal(createBeeBridgeQualifier([record], [record.id])({ ...tuple(), bridgeLifetimeSeconds: 220, cleanupGraceMs: 5000, streamBounds: DOCKER_BEE_STREAM_BOUNDS }), true);
  });

  it('finds no pass for any other tuple', async () => {
    await store.record(checked());
    for (const other of [{ ...tuple(), imageId: `sha256:${'e'.repeat(64)}` }, { ...tuple(), engineVersion: '29.1.4' },
      { ...tuple(), platform: { os: 'linux', architecture: 'arm64', variant: 'v8' } }, { ...tuple(), bridgeRevision: `sha256:${'f'.repeat(64)}` }]) {
      assert.equal(await store.passFor(other), null, JSON.stringify(other));
    }
  });

  it('does not count a pass another revision of the check made', async () => {
    await store.record(checked());
    await pool.query("UPDATE bee_bridge_qualifications SET harness_revision = $1", [`sha256:${'0'.repeat(64)}`]);
    assert.equal(await store.passFor(tuple()), null);
  });

  it('keeps every failure with the check it failed, and none of them qualifies anything', async () => {
    await store.record(checked(syntheticBeeBridgeCheckAnswer({ devTcp: 'missing' })));
    await store.record(checked(syntheticBeeBridgeCheckAnswer({ missing: ['timeout'] })));
    assert.deepEqual((await rows()).map(row => [row.outcome, row.failed_check]), [['failed', 'dev_tcp'], ['failed', 'timeout']]);
    assert.equal(await store.passFor(tuple()), null);
    await store.record(checked());
    assert.ok(await store.passFor(tuple()), 'a later attempt that passes qualifies the tuple');
  });

  it('lands one pass when two first transfers race on a new tuple, and keeps the first host it was seen on', async () => {
    await Promise.all([store.record(checked(undefined, tuple(), 'bee-eu-1')), store.record(checked(undefined, tuple(), 'bee-eu-2')),
      store.record(checked(undefined, tuple(), 'bee-eu-3')), store.record(checked(syntheticBeeBridgeCheckAnswer({ devTcp: 'missing' }), tuple(), 'bee-eu-4'))]);
    const all = await rows();
    assert.equal(all.filter(row => row.outcome === 'passed').length, 1);
    assert.equal(all.filter(row => row.outcome === 'failed').length, 1, 'a failure in the same race is kept beside the pass');
    await store.record(checked(undefined, tuple(), 'bee-eu-5'));
    assert.equal((await rows()).filter(row => row.outcome === 'passed').length, 1);
    assert.ok(['bee-eu-1', 'bee-eu-2', 'bee-eu-3'].includes(all.find(row => row.outcome === 'passed')!.host_alias));
  });

  it('refuses a row whose outcome and failed check disagree', async () => {
    await assert.rejects(pool.query(`INSERT INTO bee_bridge_qualifications (image_id, engine_version, platform_os, platform_architecture, platform_variant,
      bridge_revision, harness_revision, outcome, failed_check, evidence, evidence_digest, host_alias)
      VALUES ($1, '29.1.3', 'linux', 'amd64', '', $2, $3, 'passed', 'bash', '{}', $4, 'bee-eu-1')`,
      [tuple().imageId, DOCKER_BEE_BRIDGE_REVISION, BEE_BRIDGE_CHECK_REVISION, `sha256:${'a'.repeat(64)}`]), /check constraint/i);
  });
});
