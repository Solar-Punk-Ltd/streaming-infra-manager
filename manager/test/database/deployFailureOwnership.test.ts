import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import type { Profile } from '../../src/types/index.js';

const root = mkdtempSync(join(tmpdir(), 't04b-deploy-failure-'));
process.env.SHLS_ROOT = join(root, 'bundled');
process.env.BEE_DATA_ROOT = join(root, 'data');
mkdirSync(process.env.SHLS_ROOT);
writeFileSync(join(process.env.SHLS_ROOT, '.env'), 'ENGINE=srs\n');
after(() => rm(root, { recursive: true, force: true }));

const { ProfileRepository } = await import('../../src/domain/ProfileRepository.js');
const { DeploymentOrchestrator } = await import('../../src/domain/DeploymentOrchestrator.js');
const { PostgresBuildLedger } = await import('../../src/domain/versions/PostgresBuildLedger.js');
const { PostgresStackVersionRepository } = await import('../../src/domain/versions/PostgresStackVersionRepository.js');
const { deployOwnerOf } = await import('../../src/domain/versions/buildLedger.js');
const { ALLOCATION_CONTRACT } = await import('../support/allocationContract.js');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');
type GroupRepository = import('../../src/domain/DeploymentGroupRepository.js').DeploymentGroupRepository;

const port = Number(process.env.T04B_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't04b_test', connectionTimeoutMillis: 10000 };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('deploy failure ownership with real PostgreSQL and the real orchestrator', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let profiles: InstanceType<typeof ProfileRepository>;
  let versions: InstanceType<typeof PostgresStackVersionRepository>;
  let ledger: InstanceType<typeof PostgresBuildLedger>;
  let initial: Profile;

  beforeEach(async () => {
    schema = `t04b_failure_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 8, options: `-c search_path=${schema} -c statement_timeout=10000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    }
    profiles = new ProfileRepository(pool);
    versions = new PostgresStackVersionRepository(pool);
    const version = (await versions.findByName('bundled'))!;
    await versions.markBuilt(version.id, { commitSha: 'a'.repeat(40), contract: ALLOCATION_CONTRACT });
    initial = (await profiles.insertWithFreeSlot('failure-owner', 'streamer', 'DEPLOYING', { components: ['srs'], host: 'localhost' }, {
      stackVersionId: version.id, slotCap: 10, daemonId: 'test-daemon', table: ALLOCATION_CONTRACT.ports,
    }))!;
    ledger = new PostgresBuildLedger(pool, { mountedRootOf: async () => { throw new Error('No physical observation in this test'); } }, root);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  async function state() { return (await pool.query('SELECT * FROM profiles WHERE name = $1', [initial.name])).rows[0]; }
  async function references() { return (await pool.query('SELECT * FROM build_references ORDER BY id')).rows; }
  async function capture() {
    return ledger.describe(initial.name, await versions.findById(initial.stack_version_id), ['srs'], deployOwnerOf(initial));
  }
  function harness() {
    const h = orchestratorHarness([initial]);
    const orchestrator = new DeploymentOrchestrator(profiles, h.containers.asRepository(), h.runner, h.events,
      {} as GroupRepository, versions, ledger, h.attempts, h.daemon, h.operations, undefined, undefined,
      h.profiles.reservations, { publishedPorts: async () => h.published });
    return { ...h, orchestrator };
  }

  it('a refused duplicate initial request cannot mark the admitted held job ERROR', async () => {
    const h = harness();
    await h.orchestrator.startInitialDeploy(initial, ['srs']);
    const before = await state();
    const held = await references();
    await assert.rejects(h.orchestrator.startInitialDeploy(initial, ['srs']), /initial build job/);
    assert.deepEqual(await state(), before);
    assert.deepEqual(await references(), held);
    assert.equal(h.runner.runs.length, 1);
  });

  it('a replacement during a held version read is not retargeted by the initial failure', async () => {
    const h = harness();
    const entered = deferred();
    const release = deferred();
    const find = versions.findById.bind(versions);
    versions.findById = async id => { entered.resolve(); await release.promise; return find(id); };
    const pending = assert.rejects(h.orchestrator.startInitialDeploy(initial, ['srs']), /initial build job/);
    await entered.promise;
    await pool.query('UPDATE profiles SET instance_id = $1 WHERE name = $2', [randomUUID(), initial.name]);
    const before = await state();
    release.resolve();
    await pending;
    assert.deepEqual(await state(), before);
    assert.deepEqual(await references(), []);
    assert.equal(h.runner.runs.length, 0);
  });

  it('a preparation error marks the still-unclaimed initial owner ERROR', async () => {
    const h = harness();
    versions.findById = async () => { throw new Error('synthetic version failure'); };
    await assert.rejects(h.orchestrator.startInitialDeploy(initial, ['srs']), /synthetic version failure/);
    const row = await state();
    assert.equal(row.status, 'ERROR');
    assert.equal(row.deployment_phase, null);
    assert.equal(row.last_error, 'synthetic version failure');
    assert.equal(row.deploy_job_reference_id, null);
    assert.deepEqual(await references(), []);
  });

  for (const change of ['instance', 'intent', 'same-intent job'] as const) {
    it(`a delayed script failure cannot mark a later ${change} owner ERROR`, async () => {
      const h = harness();
      await h.orchestrator.startInitialDeploy(initial, ['srs']);
      if (change === 'instance') await pool.query('UPDATE profiles SET instance_id = $1', [randomUUID()]);
      else if (change === 'intent') await pool.query('UPDATE profiles SET intent_revision = intent_revision + 1');
      else {
        await profiles.markTerminal(initial.name, 'RUNNING');
        const current = (await profiles.findByName(initial.name))!;
        assert.ok(await ledger.claim(initial.name, ['RUNNING'], await versions.findById(initial.stack_version_id), ['srs'], { ...deployOwnerOf(current), intent: 'preserve' }));
      }
      const before = await state();
      const held = await references();
      const failureWrite = deferred();
      const markError = profiles.markError.bind(profiles);
      profiles.markError = async (...args) => { try { return await markError(...args); } finally { failureWrite.resolve(); } };
      if (profiles.markDeployError) {
        const markDeployError = profiles.markDeployError.bind(profiles);
        profiles.markDeployError = async (...args) => { try { return await markDeployError(...args); } finally { failureWrite.resolve(); } };
      }
      h.runner.finish(0, 1);
      await failureWrite.promise;
      assert.deepEqual(await state(), before);
      assert.deepEqual(await references(), held);
    });
  }

  it('a matching claimed failure retains its exact pointer and every artifact hold', async () => {
    const build = await capture();
    const held = await references();
    const failed = await profiles.markDeployError(initial.name, deployOwnerOf(initial), build.referenceId, 'synthetic owned failure');
    assert.equal(failed?.status, 'ERROR');
    assert.equal(failed?.deployment_phase, null);
    assert.equal(failed?.last_error, 'synthetic owned failure');
    assert.equal((await state()).deploy_job_reference_id, build.referenceId);
    assert.deepEqual(await references(), held);
  });

  it('an unclaimed failure cannot consume an already installed job', async () => {
    await capture();
    const before = await state();
    assert.equal(await profiles.markDeployError(initial.name, deployOwnerOf(initial), null, 'stale preparation'), null);
    assert.deepEqual(await state(), before);
  });

  for (const change of ['instance', 'intent', 'config', 'version', 'status', 'active job'] as const) {
    it(`the conditional error UPDATE refuses a changed ${change}`, async () => {
      const build = await capture();
      if (change === 'instance') await pool.query('UPDATE profiles SET instance_id = $1', [randomUUID()]);
      if (change === 'intent') await pool.query('UPDATE profiles SET intent_revision = intent_revision + 1');
      if (change === 'config') await pool.query('UPDATE profiles SET engine_config_revision = engine_config_revision + 1');
      if (change === 'version') {
        const other = await versions.insert({ name: 'other', gitRef: 'synthetic', rootPath: join(root, 'other') });
        await pool.query('UPDATE profiles SET stack_version_id = $1', [other.id]);
      }
      if (change === 'status') await profiles.markTerminal(initial.name, 'STOPPED');
      if (change === 'active job') await pool.query('UPDATE profiles SET deploy_job_reference_id = NULL');
      const before = await state();
      const held = await references();
      assert.equal(await profiles.markDeployError(initial.name, deployOwnerOf(initial), build.referenceId, 'old failure'), null);
      assert.deepEqual(await state(), before);
      assert.deepEqual(await references(), held);
    });
  }
});
