import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { ProfileRepository } from '../../src/domain/ProfileRepository.js';
import { ProfileService } from '../../src/domain/ProfileService.js';
import { DeploymentOrchestrator } from '../../src/domain/DeploymentOrchestrator.js';
import type { DeploymentGroupRepository } from '../../src/domain/DeploymentGroupRepository.js';
import { PostgresBuildLedger } from '../../src/domain/versions/PostgresBuildLedger.js';
import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import { PostgresEngineConfigOperationRepository } from '../../src/domain/engineConfig/PostgresEngineConfigOperationRepository.js';
import { orchestratorHarness } from '../support/orchestratorHarness.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

const port = Number(process.env.T11_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't11_test', connectionTimeoutMillis: 5000 };
const publishers = ['1080p', '720p', '480p', '360p']
  .map((rung, index) => `${rung}@http://192.0.2.10:${12015 + index * 10}<${'a'.repeat(64)}>`).join(' ');
const contract = (fps: string) => ({ ...structuredClone(ALLOCATION_CONTRACT), engineDefaults: { ABR_FPS: fps } });

describe('engine settings admission keeps its validated build through PostgreSQL publication', {
  skip: !Number.isInteger(port) || port < 1 || port > 65535,
  timeout: 60000,
}, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let root: string;
  let profiles: ProfileRepository;
  let versions: PostgresStackVersionRepository;
  let service: ProfileService;
  let orchestrator: DeploymentOrchestrator;
  let harness: ReturnType<typeof orchestratorHarness>;

  beforeEach(async () => {
    schema = `t11_capture_${randomBytes(8).toString('hex')}`;
    root = await mkdtemp(join(tmpdir(), 't11-capture-sql-'));
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 6, application_name: schema, options: `-c search_path=${schema} -c statement_timeout=5000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    for (const id of ['aaaaaaa', 'bbbbbbb']) {
      const dir = join(root, 'bundled.builds', id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, '.env'), 'ENGINE=srs\n');
      await writeFile(join(dir, '.stack-manifest.json'), JSON.stringify({ buildId: id, commit: id,
        builtAt: '2026-09-09T00:00:00Z', toolchain: 'synthetic fixture' }));
      await writeFile(join(dir, '.complete'), '');
    }
    profiles = new ProfileRepository(pool);
    versions = new PostgresStackVersionRepository(pool);
    await pool.query(`UPDATE stack_versions SET root_path=$1, layout='builds', build_id='aaaaaaa', commit_sha='aaaaaaa', contract=$2 WHERE id=1`,
      [join(root, 'bundled'), JSON.stringify(contract('30'))]);
    await pool.query(`INSERT INTO profiles (name, kind, components, bee_publishers, port_slot, status, stack_version_id, instance_id, engine_settings)
      VALUES ('observed','custom',ARRAY['srs','stream-uploader'],$1,1,'RUNNING',1,$2,'{"HLS_FRAGMENT":"2"}')`, [publishers, randomUUID()]);
    harness = orchestratorHarness([(await profiles.findByName('observed'))!], undefined, root);
    const ledger = new PostgresBuildLedger(pool, { mountedRootOf: async () => { throw new Error('No Docker observation in capture tests'); } }, root);
    orchestrator = new DeploymentOrchestrator(profiles, harness.containers.asRepository(), harness.runner,
      harness.events, {} as DeploymentGroupRepository, versions, ledger, harness.attempts, harness.daemon,
      new PostgresEngineConfigOperationRepository(pool), undefined, undefined, harness.profiles.reservations,
      { publishedPorts: async () => harness.published });
    service = new ProfileService(profiles, harness.containers.asRepository(), orchestrator, harness.events,
      {} as DeploymentGroupRepository, versions);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function state() {
    return { profile: (await pool.query("SELECT * FROM profiles WHERE name='observed'")).rows[0],
      jobs: (await pool.query('SELECT * FROM build_references ORDER BY id')).rows };
  }

  async function blocked() {
    const deadline = Date.now() + 3000;
    while (true) {
      if ((await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [schema])).rowCount) return;
      assert.ok(Date.now() < deadline, 'the real admission must wait on the version publication lock');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  for (const ordering of ['before-admission', 'while-claim-waits'] as const) {
    it(`refuses A to B publication ${ordering} before settings, intent, status or job writes`, async () => {
      let arrive!: () => void;
      let release!: () => void;
      const arrived = new Promise<void>(resolve => { arrive = resolve; });
      const resume = new Promise<void>(resolve => { release = resolve; });
      const reserve = orchestrator.reserveDeploy.bind(orchestrator);
      orchestrator.reserveDeploy = async (...args) => { arrive(); await resume; return reserve(...args); };
      const before = await state();
      const pending = service.updateEngineSettings('observed', { HLS_FRAGMENT: '0.5' });
      pending.catch(() => {});
      const writer = await pool.connect();
      try {
        await Promise.race([arrived, pending.then(() => { throw new Error('Settings completed before the admission hold'); })]);
        await writer.query('BEGIN');
        await writer.query("UPDATE stack_versions SET previous_build_id=build_id, build_id='bbbbbbb', commit_sha='bbbbbbb', contract=$1 WHERE id=1", [JSON.stringify(contract('25'))]);
        if (ordering === 'before-admission') {
          await writer.query('COMMIT');
          release();
        } else {
          release();
          await blocked();
          await writer.query('COMMIT');
        }
        const error: unknown = await pending.then(() => null, error => error);
        assert.deepEqual(await state(), before);
        assert.deepEqual(harness.runner.runs, []);
        assert.ok(error instanceof Error);
        assert.match(error.message, /changed after build aaaaaaa was selected/);
      } finally { release(); await writer.query('ROLLBACK'); writer.release(); await pending.catch(() => {}); }
    });
  }

  it('retains a legal unchanged build and explicit frame-rate override', async () => {
    await versions.publish(1, { buildId: 'bbbbbbb', commitSha: 'bbbbbbb', contract: contract('25') });
    const saved = await service.updateEngineSettings('observed', { HLS_FRAGMENT: '0.5', ABR_FPS: '30' });
    assert.deepEqual(saved.engine_settings, { HLS_FRAGMENT: '0.5', ABR_FPS: '30' });
    assert.equal(saved.intent_revision, 1);
    assert.equal(harness.runner.runs.length, 1);
    assert.ok(harness.runner.runs[0]!.script.includes('/bbbbbbb/'));
  });
});
