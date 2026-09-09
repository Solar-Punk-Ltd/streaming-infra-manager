import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import type { StackContract } from '@streaming-infra-manager/common';

import { EventBus } from '../../src/domain/EventBus.js';
import { PostgresStackVersionRepository } from '../../src/domain/versions/PostgresStackVersionRepository.js';
import { StackVersionService } from '../../src/domain/versions/StackVersionService.js';
import { FakeScriptSpawner } from '../support/FakeScriptSpawner.js';
import { scratchVersionsRoot } from '../support/stackFixtures.js';

const port = Number(process.env.T08_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't08_test', connectionTimeoutMillis: 5000 };
const COMMIT = 'a'.repeat(40);
const BUILD = COMMIT;
const REBUILD = `${COMMIT}-r1`;

describe('build approval in isolated PostgreSQL schemas', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let repository: PostgresStackVersionRepository;
  let id: number;

  beforeEach(async () => {
    schema = `t08_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, application_name: schema, options: `-c search_path=${schema}` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    }
    repository = new PostgresStackVersionRepository(pool);
    id = (await repository.findByName('bundled'))!.id;
    await pool.query("UPDATE stack_versions SET commit_sha = $2, layout = 'builds', build_id = $2, tested = false WHERE id = $1", [id, COMMIT]);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('binds approval to the same immutable artifact, not only its commit', async () => {
    assert.equal((await repository.setTested(id, true, COMMIT, BUILD))?.tested, true);
    await pool.query('UPDATE stack_versions SET build_id = $2, tested = false WHERE id = $1', [id, REBUILD]);
    assert.equal(await repository.setTested(id, true, COMMIT, BUILD), null);
    assert.equal((await repository.findById(id))?.tested, false);
    assert.equal((await repository.setTested(id, true, COMMIT, REBUILD))?.tested, true);
  });

  it('persists actual invalidation dates and retains the default across publication', async () => {
    const contract = {} as StackContract;
    assert.equal((await repository.findById(id))?.testedInvalidatedAt, null);
    await repository.setTested(id, true, COMMIT, BUILD);
    await repository.publish(id, { commitSha: COMMIT, buildId: BUILD, contract });
    assert.equal((await repository.findById(id))?.tested, true);
    assert.equal((await repository.findById(id))?.testedInvalidatedAt, null);
    await repository.publish(id, { commitSha: COMMIT, buildId: REBUILD, contract });
    const invalidated = (await repository.findById(id))!;
    assert.ok(invalidated.testedInvalidatedAt instanceof Date);
    assert.equal(invalidated.isDefault, true);
    assert.equal(invalidated.tested, false);
    await repository.publish(id, { commitSha: COMMIT, buildId: `${COMMIT}-r2`, contract });
    assert.deepEqual((await repository.findById(id))?.testedInvalidatedAt, invalidated.testedInvalidatedAt);
    await repository.setTested(id, true, COMMIT, `${COMMIT}-r2`);
    assert.equal((await repository.findById(id))?.testedInvalidatedAt, null);
    await repository.setTested(id, false);
    assert.equal((await repository.findById(id))?.testedInvalidatedAt, null);
  });

  it('dates bundled and legacy invalidations but never backfills an old unknown approval', async () => {
    const contract = {} as StackContract;
    await pool.query("UPDATE stack_versions SET layout = 'legacy', build_id = NULL WHERE id = $1", [id]);
    await repository.setTested(id, true, COMMIT);
    await repository.setCommitSha(id, 'b'.repeat(40));
    assert.ok((await repository.findById(id))?.testedInvalidatedAt instanceof Date);
    await repository.setTested(id, true, 'b'.repeat(40));
    await repository.markBuilt(id, { commitSha: COMMIT, contract });
    assert.ok((await repository.findById(id))?.testedInvalidatedAt instanceof Date);
    await repository.setTested(id, false);
    await repository.setCommitSha(id, 'b'.repeat(40));
    assert.equal((await repository.findById(id))?.testedInvalidatedAt, null);
  });

  it('refuses unknown identity at the write boundary and permits withdrawal while building', async () => {
    assert.equal(await repository.setTested(id, true), null);
    assert.equal(await repository.setTested(id, true, COMMIT, null), null);
    await pool.query('UPDATE stack_versions SET build_id = NULL WHERE id = $1', [id]);
    assert.equal(await repository.setTested(id, true, COMMIT, null), null);
    await pool.query("UPDATE stack_versions SET build_id = $2, status = 'building', tested = true WHERE id = $1", [id, BUILD]);
    assert.equal(await repository.setTested(id, true, COMMIT, BUILD), null);
    assert.equal((await repository.setTested(id, false))?.tested, false);
  });

  it('retains explicit legacy commit approval but refuses a legacy click after migration', async () => {
    await pool.query("UPDATE stack_versions SET layout = 'legacy', build_id = NULL WHERE id = $1", [id]);
    assert.equal((await repository.setTested(id, true, COMMIT, null))?.tested, true);
    assert.equal(await repository.setTested(id, true, COMMIT, BUILD), null);
    await pool.query("UPDATE stack_versions SET layout = 'builds', build_id = $2, tested = false WHERE id = $1", [id, BUILD]);
    assert.equal(await repository.setTested(id, true, COMMIT, null), null);
    assert.equal((await repository.findById(id))?.tested, false);
  });

  for (const legacy of [false, true]) {
    it(`rejects a ${legacy ? 'legacy migration' : 'same-commit publish'} between the service read and the conditional write`, async () => {
      if (legacy) await pool.query("UPDATE stack_versions SET layout = 'legacy', build_id = NULL WHERE id = $1", [id]);
      class PublishAfterRead extends PostgresStackVersionRepository {
        once = true;
        override async findById(versionId: number) {
          const read = await super.findById(versionId);
          if (this.once) {
            this.once = false;
            await repository.publish(versionId, { commitSha: COMMIT, buildId: REBUILD, contract: {} as StackContract });
          }
          return read;
        }
      }
      const service = new StackVersionService(new PublishAfterRead(pool), new FakeScriptSpawner(), new EventBus(), scratchVersionsRoot(), { openReferences: async () => [], pendingShipmentBuildIds: async () => [] });
      await assert.rejects(service.setTested(id, true, COMMIT, legacy ? null : BUILD), /changed since this page loaded/);
      assert.equal((await repository.findById(id))?.tested, false);
    });
  }

  it('rechecks a shown build after an already locked publisher commits', async () => {
    const publisher = await pool.connect();
    let approval: ReturnType<PostgresStackVersionRepository['setTested']> | undefined;
    try {
      await publisher.query('BEGIN');
      await publisher.query('UPDATE stack_versions SET build_id = $2, tested = false WHERE id = $1', [id, REBUILD]);
      approval = repository.setTested(id, true, COMMIT, BUILD);
      const until = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < until && !waiting) {
        const result = await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' AND query LIKE '%SET tested = $2%'", [schema]);
        waiting = result.rows.length > 0;
        if (!waiting) await delay(10);
      }
      assert.equal(waiting, true, 'the approval actually waits behind the publisher row lock');
      await publisher.query('COMMIT');
      assert.equal(await approval, null);
      assert.equal((await repository.findById(id))?.tested, false);
    } finally {
      await publisher.query('ROLLBACK');
      await approval;
      publisher.release();
    }
  });
});
