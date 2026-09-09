import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { ProfileRepository } from '../../src/domain/ProfileRepository.js';
import { deployOwnerOf } from '../../src/domain/versions/buildLedger.js';
import { PostgresBuildLedger } from '../../src/domain/versions/PostgresBuildLedger.js';
import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import { BUILD_COMPLETE_MARKER, BUILD_MANIFEST_FILE } from '../../src/domain/versions/buildManifest.js';
import { buildDirFor } from '../../src/domain/versions/stackPaths.js';
import type { StackVersionRecord } from '../../src/domain/versions/StackVersionRepository.js';
import type { Profile, ProfileStatus } from '../../src/types/index.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

const port = Number(process.env.T12_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't12_test', connectionTimeoutMillis: 10000 };
const A = 'a'.repeat(40);

describe('build claims preserve deployment intent in isolated PostgreSQL', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let root: string;
  let profiles: ProfileRepository;
  let versions: PostgresStackVersionRepository;
  let ledger: PostgresBuildLedger;
  let selected: StackVersionRecord;
  let initial: Profile;

  beforeEach(async () => {
    schema = `t12_claim_${randomBytes(8).toString('hex')}`;
    root = await mkdtemp(join(tmpdir(), 't12-build-claim-'));
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 5, options: `-c search_path=${schema} -c statement_timeout=10000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    }
    profiles = new ProfileRepository(pool);
    versions = new PostgresStackVersionRepository(pool);
    ledger = new PostgresBuildLedger(pool, {
      mountedRootOf: async () => { throw new Error('this SQL regression must not inspect containers'); },
    }, root);
    const version = await versions.insert({ name: 'test-stack', gitRef: 'test', rootPath: join(root, 'test-stack') });
    const artifact = buildDirFor(root, version.name, A);
    await mkdir(artifact, { recursive: true });
    await writeFile(join(artifact, BUILD_MANIFEST_FILE), JSON.stringify({ buildId: A, commit: A, builtAt: '2026-01-01T00:00:00Z', toolchain: 'synthetic' }));
    await writeFile(join(artifact, BUILD_COMPLETE_MARKER), '');
    selected = (await versions.publish(version.id, { buildId: A, commitSha: A, contract: ALLOCATION_CONTRACT }))!;
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function insert(status: ProfileStatus) {
    initial = (await profiles.insertWithFreeSlot('test-stream', 'streamer', status, {}, {
      stackVersionId: selected.id, slotCap: 10, daemonId: 'synthetic-daemon', table: ALLOCATION_CONTRACT.ports,
    }))!;
  }

  async function references() {
    return (await pool.query('SELECT id, holder_kind, holder_id, resolved_at FROM build_references ORDER BY id')).rows;
  }

  for (const [status, phase, oldPhase] of [
    ['RUNNING', 'restarting', 'starting'],
    ['STOPPED', 'starting', 'restarting'],
    ['ERROR', null, 'restarting'],
  ] as const) {
    it(`one of two competing claims from ${status} records ${phase ?? 'unknown'} intent from the prior status`, async () => {
      await insert(status);
      await pool.query('UPDATE profiles SET deployment_phase = $1', [oldPhase]);
      const results = await Promise.all([
        ledger.claim('test-stream', [status], selected, ['srs'], { ...deployOwnerOf(initial), intent: 'preserve' }),
        ledger.claim('test-stream', [status], selected, ['srs'], { ...deployOwnerOf(initial), intent: 'preserve' }),
      ]);
      const winners = results.filter(result => result !== null);
      assert.equal(winners.length, 1);
      assert.equal(winners[0]?.profile.deployment_phase, phase);
      assert.equal((await new ProfileRepository(pool).findByName('test-stream'))?.deployment_phase, phase);
      assert.equal((await profiles.findByName('test-stream'))?.status, 'DEPLOYING');
      assert.equal((await references()).length, 1, 'only the winner creates a job reference');
    });
  }

  it('refuses a stale selected build without changing prior phase, status, errors or references', async () => {
    await insert('RUNNING');
    await pool.query("UPDATE profiles SET deployment_phase = 'starting', last_error = 'prior failure', last_error_at = '2026-01-01'");
    const before = await profiles.findByName('test-stream');
    const beforeReferences = await references();
    await versions.publish(selected.id, { buildId: `${A}-r1`, commitSha: A, contract: ALLOCATION_CONTRACT });
    await assert.rejects(ledger.claim('test-stream', ['RUNNING'], selected, ['srs'], { ...deployOwnerOf(initial), intent: 'preserve' }), /changed/);
    assert.deepEqual(await profiles.findByName('test-stream'), before);
    assert.deepEqual(await references(), beforeReferences);
  });

  it('rolls back the phase and claim when recording the job reference fails', async () => {
    await insert('RUNNING');
    const before = await profiles.findByName('test-stream');
    await pool.query("ALTER TABLE build_references ADD CONSTRAINT reject_test_job CHECK (holder_id <> 'test-stream')");
    await assert.rejects(ledger.claim('test-stream', ['RUNNING'], selected, ['srs'], { ...deployOwnerOf(initial), intent: 'preserve' }), /reject_test_job/);
    assert.deepEqual(await profiles.findByName('test-stream'), before);
    assert.deepEqual(await references(), []);
  });

  for (const finish of ['terminal', 'failure', 'interrupted'] as const) {
    it(`clears the phase of an admitted build on ${finish}`, async () => {
      await insert('RUNNING');
      const claim = await ledger.claim('test-stream', ['RUNNING'], selected, ['srs'], { ...deployOwnerOf(initial), intent: 'preserve' });
      assert.equal(claim?.profile.deployment_phase, 'restarting');
      if (finish === 'terminal') await profiles.markTerminal('test-stream', 'RUNNING');
      else if (finish === 'failure') await profiles.markError('test-stream', 'synthetic failure');
      else await profiles.resetOrphanedTransitions();
      assert.equal((await profiles.findByName('test-stream'))?.deployment_phase, null);
      assert.equal((await references()).length, 1, 'status completion alone does not resolve an uncertain job');
      assert.equal((await references())[0]?.resolved_at, null);
    });
  }
});
