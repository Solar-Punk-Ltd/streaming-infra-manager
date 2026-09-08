import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { ProfileRepository } from '../../src/domain/ProfileRepository.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';

const port = Number(process.env.T12_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't12_test' };
const placement = { stackVersionId: 1, slotCap: 10, daemonId: 'synthetic-daemon', table: ALLOCATION_CONTRACT.ports };

describe('deployment intent in isolated PostgreSQL', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let repository: ProfileRepository;
  beforeEach(async () => {
    schema = `t12_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, options: `-c search_path=${schema}` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    }
    repository = new ProfileRepository(pool);
  });
  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('records starting for a new direct deployment and returns it after reload', async () => {
    const created = await repository.insertWithFreeSlot('new-stream', 'streamer', 'DEPLOYING', {}, placement);
    assert.equal(created?.deployment_phase, 'starting');
    assert.equal((await new ProfileRepository(pool).findByName('new-stream'))?.deployment_phase, 'starting');
  });

  it('records prior status atomically and does not change a rejected claim', async () => {
    for (const [status, phase] of [['RUNNING', 'restarting'], ['STOPPED', 'starting'], ['ERROR', null]] as const) {
      const name = `from-${status.toLowerCase()}`;
      await repository.insertWithFreeSlot(name, 'streamer', status, {}, placement);
      const results = await Promise.all([
        repository.transitionStatus(name, 'DEPLOYING', [status]),
        repository.transitionStatus(name, 'DEPLOYING', [status]),
      ]);
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal((await repository.findByName(name))?.deployment_phase, phase);
    }
  });

  it('clears intent at terminal, failure, and interrupted transitions', async () => {
    await repository.insertWithFreeSlot('test-stream', 'streamer', 'DEPLOYING', {}, placement);
    assert.equal((await repository.markTerminal('test-stream', 'RUNNING'))?.deployment_phase, null);
    await repository.transitionStatus('test-stream', 'DEPLOYING', ['RUNNING']);
    assert.equal((await repository.markError('test-stream', 'test failure'))?.deployment_phase, null);
    await repository.transitionStatus('test-stream', 'DEPLOYING', ['ERROR']);
    assert.equal((await repository.resetOrphanedTransitions())[0]?.deployment_phase, null);
  });
});
