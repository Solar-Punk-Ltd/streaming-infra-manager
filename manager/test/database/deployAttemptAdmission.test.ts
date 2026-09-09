import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { PostgresDeployAttemptRepository } from '../../src/domain/PostgresDeployAttemptRepository.js';

const port = Number(process.env.T01_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't01_test', connectionTimeoutMillis: 10000 };
const daemonId = 'synthetic-daemon';
const project = 'synthetic-project';
const emptyToken = { daemonId, project, latestAttemptId: null as string | null };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('attempt history protects container snapshot admission in PostgreSQL', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let attempts: PostgresDeployAttemptRepository;

  beforeEach(async () => {
    schema = `t01_attempt_admission_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 5, options: `-c search_path=${schema} -c statement_timeout=10000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    }
    attempts = new PostgresDeployAttemptRepository(pool);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  function request(jobId: string, token = emptyToken) {
    return { daemonId, project, target: 'localhost', jobId, kind: 'fixed' as const,
      services: ['srs'], preJobContainerIds: ['before'], snapshotToken: token };
  }
  async function unchangedWrites() {
    return (await pool.query(`SELECT
      (SELECT count(*) FROM deploy_attempts)::int AS attempts,
      (SELECT count(*) FROM build_references)::int AS jobs,
      (SELECT count(*) FROM engine_config_operations)::int AS operations`)).rows[0];
  }

  it('captures empty and released-only history using decimal text identities', async () => {
    assert.deepEqual(await attempts.captureSnapshotToken(daemonId, project), emptyToken);
    const first = await attempts.open(request('first'));
    await attempts.resolve(first.id, { state: 'released', reason: 'synthetic complete observation' });
    assert.deepEqual(await attempts.captureSnapshotToken(daemonId, project), { ...emptyToken, latestAttemptId: String(first.id) });
  });

  it('refuses a snapshot capture while a prior attempt is open, before reading Docker', async () => {
    const first = await attempts.open(request('first'));
    let dockerReads = 0;
    const capture = async () => {
      const token = await attempts.captureSnapshotToken(daemonId, project);
      dockerReads += 1;
      return token;
    };
    await assert.rejects(capture(), /unresolved|holds the/i);
    await attempts.resolve(first.id, { state: 'released', reason: 'completed after capture was refused' });
    assert.equal(dockerReads, 0);
    assert.deepEqual(await unchangedWrites(), { attempts: 1, jobs: 0, operations: 0 });
  });

  it('refuses a held snapshot after an intervening attempt opens and fully resolves', async () => {
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM deploy_attempts')).rows[0].n, 0);
    const entered = deferred();
    const finishSnapshot = deferred();
    const oldSnapshot = (async () => {
      const token = structuredClone(emptyToken);
      entered.resolve();
      await finishSnapshot.promise;
      return request('stale-snapshot', token);
    })();
    await entered.promise;
    const intervening = await attempts.open(request('intervening'));
    await attempts.resolve(intervening.id, { state: 'released', reason: 'synthetic new container' });
    const before = await unchangedWrites();
    finishSnapshot.resolve();
    await assert.rejects(attempts.open(await oldSnapshot), /snapshot|history|changed/i);
    assert.deepEqual(await unchangedWrites(), before);
  });

  it('requires a fresh history token even after the intervening attempt was explicitly released', async () => {
    const first = await attempts.open(request('first'));
    await attempts.release(first.id, 'synthetic operator');
    const before = await unchangedWrites();
    await assert.rejects(attempts.open(request('stale')), /snapshot|history|changed/i);
    assert.deepEqual(await unchangedWrites(), before);
    assert.ok(await attempts.open(request('fresh', { ...emptyToken, latestAttemptId: String(first.id) })));
  });

  for (const mismatch of ['daemon', 'project', 'malformed id'] as const) {
    it(`refuses a ${mismatch} token without a new guard`, async () => {
      const token = { ...emptyToken,
        ...(mismatch === 'daemon' ? { daemonId: 'other-daemon' } : {}),
        ...(mismatch === 'project' ? { project: 'other-project' } : {}),
        ...(mismatch === 'malformed id' ? { latestAttemptId: '1.0' } : {}),
      };
      await assert.rejects(attempts.open(request('wrong-token', token)), /snapshot|token|history/i);
      assert.deepEqual(await unchangedWrites(), { attempts: 0, jobs: 0, operations: 0 });
    });
  }

  it('does not invalidate a fixed-image project snapshot for another project history', async () => {
    const other = await attempts.open({ ...request('other'), project: 'other-project', snapshotToken: { ...emptyToken, project: 'other-project' } });
    await attempts.resolve(other.id, { state: 'released', reason: 'synthetic complete' });
    assert.ok(await attempts.open(request('current')));
  });

  it('retains legacy admission callers while they still advance the observed project history', async () => {
    const { snapshotToken: _token, ...legacy } = request('legacy');
    const first = await attempts.open(legacy);
    await attempts.resolve(first.id, { state: 'released', reason: 'synthetic legacy complete' });
    await assert.rejects(attempts.open(request('stale-after-legacy')), /snapshot|history|changed/i);
  });
});
