import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { EventBus } from '../../src/domain/EventBus.js';
import { PostgresBuildLedger } from '../../src/domain/versions/PostgresBuildLedger.js';
import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import { StackVersionService } from '../../src/domain/versions/StackVersionService.js';
import type { StackVersionRecord } from '../../src/domain/versions/StackVersionRepository.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

const port = Number(process.env.T04A_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't04a_test', connectionTimeoutMillis: 5000 };
const BUILD = 'a'.repeat(40);

describe('version removal before files disappear in isolated PostgreSQL', {
  skip: !Number.isInteger(port) || port < 1 || port > 65535, timeout: 15000,
}, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let root: string;
  let versions: PostgresStackVersionRepository;
  let selected: StackVersionRecord;
  let service: StackVersionService;
  let sentinels: string[];
  let ledger: PostgresBuildLedger;
  const observer = { mountedRootOf: async (): Promise<string | null> => { throw new Error('No Docker observation in removal tests.'); } };
  const runner = { run: (): never => { throw new Error('No real builds in removal tests.'); } };

  beforeEach(async () => {
    schema = `t04a_removal_${randomBytes(8).toString('hex')}`;
    root = await mkdtemp(join(tmpdir(), 't04a-version-removal-'));
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 8, application_name: schema, options: `-c search_path=${schema} -c statement_timeout=10000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    versions = new PostgresStackVersionRepository(pool);
    const inserted = await versions.insert({ name: 'review-stack', gitRef: 'review', rootPath: join(root, 'review-stack') });
    selected = (await versions.publish(inserted.id, { buildId: BUILD, commitSha: BUILD, contract: ALLOCATION_CONTRACT }))!;
    sentinels = [];
    for (const directory of ['review-stack', 'review-stack.repo', 'review-stack.builds']) {
      await mkdir(join(root, directory));
      const sentinel = join(root, directory, 'synthetic-sentinel');
      await writeFile(sentinel, 'owned fixture');
      sentinels.push(sentinel);
    }
    const artifact = join(root, 'review-stack.builds', BUILD);
    await mkdir(artifact);
    await writeFile(join(artifact, '.complete'), '');
    await writeFile(join(artifact, '.stack-manifest.json'), JSON.stringify({ buildId: BUILD, commit: BUILD, builtAt: '2026-09-09T00:00:00Z', toolchain: 'synthetic' }));
    ledger = new PostgresBuildLedger(pool, observer, root);
    service = new StackVersionService(versions, runner, new EventBus(), root, ledger);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function intact() {
    for (const file of sentinels) assert.equal(existsSync(file), true, 'all owned files must remain before a refused removal');
    assert.notEqual(await versions.findById(selected.id), null);
  }

  async function serviceRefuses() {
    let caught: unknown;
    try { await service.remove(selected.id); } catch (error) { caught = error; }
    await intact();
    assert.ok(caught instanceof Error, 'removal must explain its refusal');
  }

  for (const holder of ['job', 'snapshot', 'operation', 'execution']) {
    it(`keeps files and row while an unresolved ${holder} reference remains`, async () => {
      await pool.query('INSERT INTO build_references (version_id, build_id, holder_kind, holder_id) VALUES ($1,$2,$3,$4)', [selected.id, BUILD, holder, 'synthetic-owner']);
      await serviceRefuses();
    });
  }

  for (const state of ['registered', 'prepared', 'published', 'superseded']) {
    it(`keeps files and row for a ${state} shipment, including registration without a candidate`, async () => {
      const candidate = state === 'prepared' || state === 'published';
      const manifest = { buildId: BUILD, commit: BUILD, builtAt: '2026-09-09T00:00:00Z', toolchain: 'synthetic' };
      const metadata = { manifestBytes: JSON.stringify(manifest), manifestMode: 420, completeBytes: '', completeMode: 420 };
      await pool.query(`INSERT INTO bundled_shipments (shipment_id, version_id, package_digest, commit_sha, expected_publication_revision, root_path, state,
        candidate_build_id, candidate_kind, candidate_manifest, candidate_metadata, artifact_digest, candidate_contract, receipt_revision, published_at)
        VALUES ($1,$2,$3,$4,0,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13,$14)`, [
        randomUUID(), selected.id, 'd'.repeat(64), BUILD, selected.rootPath, state,
        candidate ? BUILD : null, candidate ? 'reuse' : null, candidate ? JSON.stringify(manifest) : null,
        candidate ? JSON.stringify(metadata) : null, candidate ? 'e'.repeat(64) : null,
        candidate ? JSON.stringify(ALLOCATION_CONTRACT) : null, state === 'published' ? 1 : null,
        state === 'published' ? new Date() : null,
      ]);
      await serviceRefuses();
    });
  }

  for (const state of ['registered', 'copying', 'ready', 'launch-uncertain', 'deleting']) {
    it(`keeps files for a ${state} execution whose separate reference is missing`, async () => {
      await pool.query(`INSERT INTO execution_roots (execution_id, version_id, build_id, commit_sha, source_root, artifact_digest,
        profile_name, profile_instance_id, intent_revision, profile_status, job_reference_id, target_alias, daemon_id,
        project, action, services, root_path, reference_id, state, copy_token)
        VALUES ($1,$2,$3,$3,$4,$5,'removed-profile',$6,2,'DEPLOYING',555,'localhost','synthetic-daemon',
        'removed-profile','deploy',ARRAY['srs'],$7,556,$8,$9)`, [randomUUID(), selected.id, BUILD,
        join(root, 'review-stack.builds', BUILD), 'e'.repeat(64), randomUUID(), join(root, '.executions', randomUUID()), state, randomUUID()]);
      await serviceRefuses();
    });
  }

  it('still removes an unheld version and its three owned trees', async () => {
    await service.remove(selected.id);
    assert.equal(await versions.findById(selected.id), null);
    for (const file of sentinels) assert.equal(existsSync(file), false);
  });
});
