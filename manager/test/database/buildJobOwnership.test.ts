import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { ProfileRepository } from '../../src/domain/ProfileRepository.js';
import { PostgresBuildLedger } from '../../src/domain/versions/PostgresBuildLedger.js';
import { PostgresExecutionRootRepository } from '../../src/domain/versions/PostgresExecutionRootRepository.js';
import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import { BUILD_COMPLETE_MARKER, BUILD_MANIFEST_FILE } from '../../src/domain/versions/buildManifest.js';
import { buildDirFor } from '../../src/domain/versions/stackPaths.js';
import type { StackVersionRecord } from '../../src/domain/versions/StackVersionRepository.js';
import type { Profile } from '../../src/types/index.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

const port = Number(process.env.T04B_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't04b_test', connectionTimeoutMillis: 10000 };
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function expectation(profile: Profile) {
  return {
    instanceId: profile.instance_id, intentRevision: profile.intent_revision,
    configRevision: profile.engine_config_revision, stackVersionId: profile.stack_version_id,
  };
}

describe('canonical build job ownership in isolated PostgreSQL', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
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
    root = await mkdtemp(join(tmpdir(), 't04b-owned-job-'));
    schema = `t04b_owned_job_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 8, options: `-c search_path=${schema} -c statement_timeout=10000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    }
    profiles = new ProfileRepository(pool);
    versions = new PostgresStackVersionRepository(pool);
    ledger = new PostgresBuildLedger(pool, { mountedRootOf: async () => { throw new Error('No physical observation in ownership tests'); } }, root);
    const version = await versions.insert({ name: 'owned-stack', gitRef: 'synthetic', rootPath: join(root, 'owned-stack') });
    for (const buildId of [A, B]) {
      const artifact = buildDirFor(root, version.name, buildId);
      await mkdir(artifact, { recursive: true });
      await writeFile(join(artifact, BUILD_MANIFEST_FILE), JSON.stringify({ buildId, commit: buildId, builtAt: '2026-01-01T00:00:00Z', toolchain: 'synthetic' }));
      await writeFile(join(artifact, BUILD_COMPLETE_MARKER), '');
    }
    selected = (await versions.publish(version.id, { buildId: A, commitSha: A, contract: ALLOCATION_CONTRACT }))!;
    initial = (await profiles.insertWithFreeSlot('owned', 'streamer', 'RUNNING', {}, {
      stackVersionId: selected.id, slotCap: 10, daemonId: 'synthetic-daemon', table: ALLOCATION_CONTRACT.ports,
    }))!;
    await pool.query("INSERT INTO deploy_targets (alias, daemon_id, verified_at) VALUES ('localhost', 'synthetic-daemon', NOW())");
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    if (root) await rm(root, { recursive: true, force: true });
  });

  function claim(profile = initial, intent: 'advance' | 'preserve' = 'advance') {
    return ledger.claim(profile.name, ['RUNNING', 'STOPPED', 'ERROR'], selected, ['srs'], {
      ...expectation(profile), intent, supersedeReason: 'Synthetic operator action.',
    });
  }
  async function rows() { return (await pool.query('SELECT * FROM build_references ORDER BY id')).rows; }
  async function state() { return (await pool.query('SELECT * FROM profiles WHERE name = $1', [initial.name])).rows[0]; }
  async function openOperation() {
    return (await pool.query<{ id: number }>(
      `INSERT INTO engine_config_operations (profile_name, profile_instance_id, engine, kind,
        previous_config, previous_is_template, applied_revision, intent_revision, state)
       VALUES ($1, $2, 'srs', 'apply', NULL, true, $3, $4, 'watching') RETURNING id`,
      [initial.name, initial.instance_id, initial.engine_config_revision, initial.intent_revision],
    )).rows[0]!.id;
  }

  it('records the final claimed instance and incremented intent, immediately usable by execution registration', async () => {
    const result = (await claim())!;
    assert.ok(result);
    assert.equal(result.profile.intent_revision, initial.intent_revision + 1);
    assert.equal(result.profile.deployment_phase, 'restarting');
    const [job] = await rows();
    assert.equal(job.profile_instance_id, result.profile.instance_id);
    assert.equal(job.intent_revision, result.profile.intent_revision);
    assert.equal((await state()).deploy_job_reference_id, job.id);
    const executions = new PostgresExecutionRootRepository(pool, join(root, '.executions'));
    const execution = await executions.register({
      executionId: randomUUID(), source: { versionId: selected.id, buildId: A, commit: A, root: result.descriptor.root, artifactDigest: 'd'.repeat(64) },
      profile: { name: result.profile.name, instanceId: result.profile.instance_id, intentRevision: result.profile.intent_revision, status: 'DEPLOYING' },
      jobReferenceId: result.descriptor.referenceId!, target: { alias: 'localhost', daemonId: 'synthetic-daemon' }, action: 'deploy', services: ['srs'],
    });
    assert.equal(execution.jobReferenceId, job.id);
  });

  for (const changed of ['instance', 'intent', 'config', 'version'] as const) {
    it(`refuses a changed ${changed} after the initial read without changing the new owner`, async () => {
      if (changed === 'instance') await pool.query('UPDATE profiles SET instance_id = $1', [randomUUID()]);
      if (changed === 'intent') await pool.query('UPDATE profiles SET intent_revision = intent_revision + 1');
      if (changed === 'config') await pool.query('UPDATE profiles SET engine_config_revision = engine_config_revision + 1');
      if (changed === 'version') await pool.query("UPDATE profiles SET stack_version_id = (SELECT id FROM stack_versions WHERE name = 'bundled')");
      const before = await state();
      assert.equal(await claim(), null);
      assert.deepEqual(await state(), before);
      assert.deepEqual(await rows(), []);
    });
  }

  it('gives one competing claimant one intent and one owned job', async () => {
    const results = await Promise.all([claim(), claim()]);
    const winners = results.filter(result => result !== null);
    assert.equal(winners.length, 1);
    assert.equal(winners[0]!.profile.intent_revision, initial.intent_revision + 1);
    assert.equal((await rows()).length, 1);
    assert.equal((await rows())[0].intent_revision, winners[0]!.profile.intent_revision);
  });

  it('supersedes an open operation in the same commit as the operator claim', async () => {
    const operationId = await openOperation();
    const result = (await claim())!;
    assert.equal(result.profile.engine_config_state, 'superseded');
    assert.equal((await pool.query('SELECT state FROM engine_config_operations WHERE id = $1', [operationId])).rows[0].state, 'superseded');
  });

  it('rolls back the claim, intent, operation change and reference when the job insert fails', async () => {
    const operationId = await openOperation();
    const before = await state();
    const priorOperation = (await pool.query('SELECT * FROM engine_config_operations WHERE id = $1', [operationId])).rows[0];
    await pool.query("ALTER TABLE build_references ADD CONSTRAINT reject_owned_job CHECK (holder_kind <> 'job')");
    await assert.rejects(claim(), /reject_owned_job/);
    assert.deepEqual(await state(), before);
    assert.deepEqual((await pool.query('SELECT * FROM engine_config_operations WHERE id = $1', [operationId])).rows[0], priorOperation);
    assert.deepEqual(await rows(), []);
  });

  it('preserves recovery intent and leaves the current operation open', async () => {
    const operationId = await openOperation();
    const result = (await claim(initial, 'preserve'))!;
    assert.equal(result.profile.intent_revision, initial.intent_revision);
    assert.equal((await rows())[0].profile_instance_id, initial.instance_id);
    assert.equal((await rows())[0].intent_revision, initial.intent_revision);
    assert.equal((await pool.query('SELECT state FROM engine_config_operations WHERE id = $1', [operationId])).rows[0].state, 'watching');
  });

  it('describes only the exact inserted DEPLOYING owner without advancing intent', async () => {
    const inserted = (await profiles.transitionStatus(initial.name, 'DEPLOYING', ['RUNNING']))!;
    const build = await ledger.describe(inserted.name, selected, ['srs'], expectation(inserted));
    assert.ok(build.referenceId);
    const [job] = await rows();
    assert.equal(job.profile_instance_id, inserted.instance_id);
    assert.equal(job.intent_revision, inserted.intent_revision);
    assert.equal((await state()).deploy_job_reference_id, build.referenceId);
  });

  for (const changed of ['instance', 'intent', 'status', 'missing-version'] as const) {
    it(`refuses initial describe after ${changed} changes without a partial reference`, async () => {
      const inserted = (await profiles.transitionStatus(initial.name, 'DEPLOYING', ['RUNNING']))!;
      if (changed === 'instance') await pool.query('UPDATE profiles SET instance_id = $1', [randomUUID()]);
      if (changed === 'intent') await pool.query('UPDATE profiles SET intent_revision = intent_revision + 1');
      if (changed === 'status') await profiles.markTerminal(initial.name, 'RUNNING');
      if (changed === 'missing-version') {
        await pool.query('DELETE FROM profiles WHERE name = $1', [initial.name]);
        await pool.query('DELETE FROM stack_versions WHERE id = $1', [selected.id]);
      }
      const before = await state();
      await assert.rejects(ledger.describe(inserted.name, selected, ['srs'], expectation(inserted)));
      assert.deepEqual(await state(), before);
      assert.deepEqual(await rows(), []);
    });
  }

  it('cancels only the exact owned unstarted claim and leaves an older unrelated hold', async () => {
    await pool.query("INSERT INTO build_references (version_id, build_id, holder_kind, holder_id, services) VALUES ($1, $2, 'job', 'owned', ARRAY['stream-uploader'])", [selected.id, A]);
    const result = (await claim())!;
    const cancelled = await ledger.cancelClaim(result.profile, result.descriptor.referenceId!, 'RUNNING');
    assert.equal(cancelled?.status, 'RUNNING');
    assert.equal(cancelled?.deployment_phase, null);
    const references = await rows();
    assert.equal(references[0].resolved_at, null);
    assert.ok(references[1].resolved_at);
    assert.equal((await state()).deploy_job_reference_id, null);
  });

  for (const changed of ['instance', 'intent', 'status'] as const) {
    it(`an old cancellation cannot alter changed ${changed} ownership`, async () => {
      const result = (await claim())!;
      if (changed === 'instance') await pool.query('UPDATE profiles SET instance_id = $1', [randomUUID()]);
      if (changed === 'intent') await pool.query('UPDATE profiles SET intent_revision = intent_revision + 1');
      if (changed === 'status') await profiles.markTerminal(initial.name, 'ERROR');
      const before = await state();
      const references = await rows();
      assert.equal(await ledger.cancelClaim(result.profile, result.descriptor.referenceId!, 'RUNNING'), null);
      assert.deepEqual(await state(), before);
      assert.deepEqual(await rows(), references);
    });
  }

  it('an older same-intent claim cannot cancel a newer recovery claim', async () => {
    const first = (await claim(initial, 'preserve'))!;
    await profiles.markTerminal(initial.name, 'RUNNING');
    const second = (await claim((await profiles.findByName(initial.name))!, 'preserve'))!;
    assert.equal(first.profile.intent_revision, second.profile.intent_revision);
    const before = await state();
    assert.equal(await ledger.cancelClaim(first.profile, first.descriptor.referenceId!, 'RUNNING'), null);
    assert.deepEqual(await state(), before);
    assert.ok((await rows()).every(row => row.resolved_at === null));
    assert.equal((await ledger.cancelClaim(second.profile, second.descriptor.referenceId!, 'RUNNING'))?.status, 'RUNNING');
  });

  it('does not cancel a job after launch uncertainty is durable', async () => {
    const result = (await claim())!;
    const executions = new PostgresExecutionRootRepository(pool, join(root, '.executions'));
    const input = {
      executionId: randomUUID(), source: { versionId: selected.id, buildId: A, commit: A, root: result.descriptor.root, artifactDigest: 'd'.repeat(64) },
      profile: { name: result.profile.name, instanceId: result.profile.instance_id, intentRevision: result.profile.intent_revision, status: 'DEPLOYING' as const },
      jobReferenceId: result.descriptor.referenceId!, target: { alias: 'localhost', daemonId: 'synthetic-daemon' }, action: 'deploy' as const, services: ['srs'],
    };
    await executions.register(input);
    const copying = (await executions.beginCopy(input.executionId))!;
    await executions.markReady(input.executionId, copying.copyToken!, input.source.artifactDigest);
    assert.ok(await executions.claimLaunch(input.executionId));
    const before = await state();
    const references = await rows();
    assert.equal(await ledger.cancelClaim(result.profile, result.descriptor.referenceId!, 'RUNNING'), null);
    assert.deepEqual(await state(), before);
    assert.deepEqual(await rows(), references);
  });

  for (const stage of ['register', 'ready', 'launch'] as const) {
    it(`a same-intent successor prevents the old execution from ${stage}`, async () => {
      const first = (await claim(initial, 'preserve'))!;
      const executions = new PostgresExecutionRootRepository(pool, join(root, '.executions'));
      const input = {
        executionId: randomUUID(), source: { versionId: selected.id, buildId: A, commit: A, root: first.descriptor.root, artifactDigest: 'd'.repeat(64) },
        profile: { name: first.profile.name, instanceId: first.profile.instance_id, intentRevision: first.profile.intent_revision, status: 'DEPLOYING' as const },
        jobReferenceId: first.descriptor.referenceId!, target: { alias: 'localhost', daemonId: 'synthetic-daemon' }, action: 'deploy' as const, services: ['srs'],
      };
      let copyToken: string | null = null;
      if (stage !== 'register') {
        await executions.register(input);
        copyToken = (await executions.beginCopy(input.executionId))!.copyToken;
        if (stage === 'launch') await executions.markReady(input.executionId, copyToken!, input.source.artifactDigest);
      }
      await profiles.markTerminal(initial.name, 'RUNNING');
      const second = (await claim((await profiles.findByName(initial.name))!, 'preserve'))!;
      assert.equal(first.profile.intent_revision, second.profile.intent_revision);
      const references = await rows();
      if (stage === 'register') await assert.rejects(executions.register(input));
      else if (stage === 'ready') await assert.rejects(executions.markReady(input.executionId, copyToken!, input.source.artifactDigest));
      else await assert.rejects(executions.claimLaunch(input.executionId));
      assert.deepEqual(await rows(), references, 'ownership movement alone never resolves a retained artifact hold');
      assert.equal((await state()).deploy_job_reference_id, second.descriptor.referenceId);
    });
  }

  it('refuses a stale build snapshot before ownership changes', async () => {
    const before = await state();
    await versions.publish(selected.id, { buildId: B, commitSha: B, contract: ALLOCATION_CONTRACT });
    await assert.rejects(claim(), /changed/);
    assert.deepEqual(await state(), before);
    assert.deepEqual(await rows(), []);
  });
});
