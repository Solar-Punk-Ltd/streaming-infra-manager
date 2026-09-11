import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

const port = Number(process.env.T04B_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't04b_test', connectionTimeoutMillis: 10000 };
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('publication revisions in isolated PostgreSQL', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let versions: PostgresStackVersionRepository;
  let id: number;
  beforeEach(async () => {
    schema = `t04b_revision_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 4, options: `-c search_path=${schema} -c statement_timeout=10000` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    }
    versions = new PostgresStackVersionRepository(pool);
    id = (await versions.findByName('bundled'))!.id;
  });
  afterEach(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });
  async function revision(): Promise<string> {
    return (await pool.query<{ publication_revision: string }>('SELECT publication_revision FROM stack_versions WHERE id = $1', [id])).rows[0]!.publication_revision;
  }

  it('starts existing rows at revision zero without claiming a publication history', async () => {
    assert.equal(await revision(), '0');
  });

  it('increments a publication exactly once even when it changes every active field', async () => {
    await versions.publish(id, { buildId: A, commitSha: A, contract: ALLOCATION_CONTRACT, rootPath: '/synthetic/bundled' });
    assert.equal(await revision(), '1');
    await versions.publish(id, { buildId: B, commitSha: B, contract: ALLOCATION_CONTRACT });
    assert.equal(await revision(), '2');
  });

  it('advances for explicit same-artifact publication and for repeated legacy build completion', async () => {
    const outcome = { buildId: A, commitSha: A, contract: ALLOCATION_CONTRACT, rootPath: '/synthetic/bundled' };
    await versions.publish(id, outcome);
    await versions.publish(id, outcome);
    assert.equal(await revision(), '2');
    await versions.markBuilt(id, { commitSha: A, contract: ALLOCATION_CONTRACT });
    await versions.markBuilt(id, { commitSha: A, contract: ALLOCATION_CONTRACT });
    assert.equal(await revision(), '4');
  });

  it('advances for legacy commit/contract writers only when their active values change', async () => {
    await versions.setCommitSha(id, A);
    await versions.setContract(id, ALLOCATION_CONTRACT);
    assert.equal(await revision(), '2');
    await versions.setCommitSha(id, A);
    await versions.setContract(id, ALLOCATION_CONTRACT);
    assert.equal(await revision(), '2');
  });

  it('fences a direct active-tuple change without relying on a particular repository method', async () => {
    await pool.query("UPDATE stack_versions SET layout = 'builds', build_id = $2, commit_sha = $2, root_path = '/synthetic/bundled' WHERE id = $1", [id, A]);
    assert.equal(await revision(), '1');
    await pool.query("UPDATE stack_versions SET root_path = '/synthetic/other' WHERE id = $1", [id]);
    assert.equal(await revision(), '2');
  });

  it('does not advance for approval/default/status/error metadata', async () => {
    await versions.publish(id, { buildId: A, commitSha: A, contract: ALLOCATION_CONTRACT, rootPath: '/synthetic/bundled' });
    const before = await revision();
    await versions.setTested(id, false);
    await versions.setDefault(id);
    await versions.markBuilding(id);
    await versions.markUpdateFailed(id, 'synthetic failure');
    assert.equal(await revision(), before);
  });

  it('refuses explicit revision regression, arbitrary jumps and null without changing the active tuple', async () => {
    await versions.setCommitSha(id, A);
    for (const value of ['0', '3', null]) {
      await assert.rejects(pool.query('UPDATE stack_versions SET publication_revision = $2, commit_sha = $3 WHERE id = $1', [id, value, B]), /revision/i);
      assert.equal(await revision(), '1');
      assert.equal((await versions.findById(id))!.commitSha, A);
    }
  });

  it('serializes concurrent accepted publications without skipping or double-counting revisions', async () => {
    await Promise.all([
      versions.publish(id, { buildId: A, commitSha: A, contract: ALLOCATION_CONTRACT, rootPath: '/synthetic/bundled' }),
      versions.publish(id, { buildId: B, commitSha: B, contract: ALLOCATION_CONTRACT, rootPath: '/synthetic/bundled' }),
    ]);
    assert.equal(await revision(), '2');
  });
});
