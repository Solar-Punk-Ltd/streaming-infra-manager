import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { it } from 'node:test';
import pg from 'pg';

import { PostgresExecutionRootRepository } from '../../src/domain/versions/PostgresExecutionRootRepository.js';
import { EXECUTIONS_PARENT, executionRecord } from '../support/executionMountFixtures.js';

const port = Number(process.env.T04B_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't04b_test', connectionTimeoutMillis: 10000 };

it('lists every unreleased execution independently of current profiles and job holds without changing any row', {
  skip: !Number.isInteger(port) || port < 1 || port > 65535, timeout: 60000,
}, async () => {
  const schema = `t04b_inventory_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool(connection);
  const pool = new pg.Pool({ ...connection, options: `-c search_path=${schema} -c statement_timeout=10000` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    }
    const record = executionRecord();
    const versionId = (await pool.query("SELECT id FROM stack_versions WHERE name = 'bundled'")).rows[0].id;
    const jobId = (await pool.query(`INSERT INTO build_references
      (version_id, build_id, holder_kind, holder_id, services, resolved_at)
      VALUES ($1, $2, 'job', 'owned', ARRAY['srs'], NOW()) RETURNING id`, [versionId, record.source.buildId])).rows[0].id;
    await pool.query("INSERT INTO profiles (name, kind, port_slot, status, stack_version_id) VALUES ('owned', 'viewer', 1, 'STOPPED', $1)", [versionId]);
    const states = ['registered', 'copying', 'ready', 'launch-uncertain', 'deleting', 'released'];
    const ids = states.map((_, i) => `${String(i + 1).repeat(8)}-1111-4111-8111-111111111111`);
    for (let i = states.length - 1; i >= 0; i--) {
      await pool.query(`INSERT INTO execution_roots (execution_id, version_id, build_id, commit_sha, source_root,
        artifact_digest, profile_name, profile_instance_id, intent_revision, profile_status, job_reference_id,
        target_alias, daemon_id, project, action, services, root_path, reference_id, state, copy_token)
        VALUES ($1,$2,$3,$4,$5,$6,'owned',$7,3,'DEPLOYING',$8,'localhost','synthetic-daemon','owned','deploy',ARRAY['srs'],$9,$10,$11,$12)`,
      [ids[i], versionId, record.source.buildId, record.source.commit, record.source.root, record.source.artifactDigest,
        record.profile.instanceId, i === 0 ? jobId : jobId + i + 100, `${EXECUTIONS_PARENT}/${ids[i]}/tree`, 1000 + i, states[i], record.copyToken]);
    }
    await pool.query("DELETE FROM profiles WHERE name = 'owned'");
    const snapshot = async () => (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(e) ORDER BY execution_id) FROM execution_roots e) AS executions,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM build_references r) AS refs,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY name) FROM profiles p) AS profiles`)).rows[0];
    const before = await snapshot();
    const result = await new PostgresExecutionRootRepository(pool, EXECUTIONS_PARENT).listUnreleased();
    assert.deepEqual(result.map(row => row.executionId), ids.slice(0, 5));
    assert.deepEqual(result.map(row => row.state), states.slice(0, 5));
    assert.deepEqual(result[0]!.source, { ...record.source, versionId });
    assert.equal(result[0]!.jobReferenceId, jobId, 'a resolved job does not hide an unreleased execution');
    assert.deepEqual(await snapshot(), before);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
