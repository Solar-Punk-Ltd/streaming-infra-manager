/**
 * That a container running from a private execution copy is recognised as
 * running the build that copy was made from.
 *
 * Measured on the live host on 2026-09-11, on the first deploy anywhere that
 * used a copy: the mount observation reads the container's working directory,
 * which is now `<versions>/.executions/<id>/tree` and not a build directory, so
 * it recorded no snapshot at all. Nothing then covered the deploy's job hold,
 * the hold stayed open for ever, and with it the copy could never be retired
 * and the build could never be pruned. Two deploys of one deployment left two
 * copies and two open holds.
 *
 * SQL suite, against the task database it owns. `pnpm test:database` in manager/.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { it } from 'node:test';
import pg from 'pg';

import { PostgresBuildLedger } from '../../src/domain/versions/PostgresBuildLedger.js';
import { executionsRootFor } from '../../src/domain/versions/stackPaths.js';
import { EXECUTION_A } from '../support/executionMountFixtures.js';

const port = Number(process.env.T04B_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't04b_test', connectionTimeoutMillis: 10000 };
const VERSIONS_ROOT = '/synthetic/versions';
const BUILD = 'a'.repeat(40);
const COPY_ROOT = `${executionsRootFor(VERSIONS_ROOT)}/${EXECUTION_A}/tree`;

it('reads a deployment running from its execution copy as running that copy\'s build', {
  skip: !Number.isInteger(port) || port < 1 || port > 65535, timeout: 60000,
}, async () => {
  const schema = `t04b_execution_mount_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool(connection);
  const pool = new pg.Pool({ ...connection, options: `-c search_path=${schema} -c statement_timeout=10000` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    }
    const versionId = (await pool.query("SELECT id FROM stack_versions WHERE name = 'bundled'")).rows[0].id;
    await pool.query(
      "UPDATE stack_versions SET layout = 'builds', build_id = $2, root_path = $3 WHERE id = $1",
      [versionId, BUILD, `${VERSIONS_ROOT}/bundled`],
    );
    await pool.query(
      "INSERT INTO profiles (name, kind, port_slot, status, stack_version_id) VALUES ('owned', 'streamer', 1, 'RUNNING', $1)",
      [versionId],
    );
    const jobId = (await pool.query(
      `INSERT INTO build_references (version_id, build_id, holder_kind, holder_id, services)
       VALUES ($1, $2, 'job', 'owned', ARRAY['srs']) RETURNING id`, [versionId, BUILD],
    )).rows[0].id;
    const holdId = (await pool.query(
      `INSERT INTO build_references (version_id, build_id, holder_kind, holder_id, services)
       VALUES ($1, $2, 'execution', $3, ARRAY['srs']) RETURNING id`, [versionId, BUILD, EXECUTION_A],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO execution_roots (execution_id, version_id, build_id, commit_sha, source_root, artifact_digest,
         profile_name, profile_instance_id, intent_revision, profile_status, job_reference_id, target_alias, daemon_id,
         project, action, services, root_path, reference_id, state, copy_token)
       VALUES ($1, $2, $3, $4, $5, $6, 'owned', gen_random_uuid(), 1, 'RUNNING', $7, 'localhost', 'synthetic-daemon',
         'owned', 'deploy', ARRAY['srs'], $8, $9, 'launch-uncertain', gen_random_uuid())`,
      [EXECUTION_A, versionId, BUILD, BUILD, `${VERSIONS_ROOT}/bundled.builds/${BUILD}`, 'd'.repeat(64), jobId, COPY_ROOT, holdId],
    );

    const ledger = new PostgresBuildLedger(pool, { mountedRootOf: async () => COPY_ROOT }, VERSIONS_ROOT);
    const observations = await ledger.observe('owned', ['srs']);

    assert.deepEqual(observations.map(o => o.buildId), [BUILD], 'the copy is read as the build it was made from');
    const snapshot = (await pool.query(
      "SELECT version_id, build_id FROM build_references WHERE holder_kind = 'snapshot' AND holder_id = 'owned/srs'",
    )).rows[0];
    assert.ok(snapshot, 'a snapshot records what the container runs');
    assert.equal(snapshot.build_id, BUILD);
    assert.equal(snapshot.version_id, versionId);
    const job = (await pool.query('SELECT resolved_at FROM build_references WHERE id = $1', [jobId])).rows[0];
    assert.notEqual(job.resolved_at, null, 'and the deploy job it covers is resolved, so the copy can be retired');
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
