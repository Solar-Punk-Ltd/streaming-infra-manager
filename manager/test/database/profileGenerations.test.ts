import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { ProfileRepository } from '../../src/domain/ProfileRepository.js';
import { PostgresChequebookOperationRepository } from '../../src/domain/chequebook/PostgresChequebookOperationRepository.js';
import { ChequebookSubmission } from '../../src/domain/chequebook/ChequebookSubmission.js';
import { operationCandidate, transactionHash, transferContext, transferIntent } from '../support/chequebookOperations.js';

const port = Number(process.env.T09_TEST_PG_PORT);
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't09_test', connectionTimeoutMillis: 30000 };
describe('profile lifetime generation in isolated PostgreSQL schemas', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let operations: PostgresChequebookOperationRepository;
  let profiles: ProfileRepository;
  beforeEach(async () => {
    schema = `t09_gen_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 10, options: `-c search_path=${schema}` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    operations = new PostgresChequebookOperationRepository(pool);
    profiles = new ProfileRepository(pool);
  });
  afterEach(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });
  async function createProfile() {
    const profile = await profiles.insertWithFreeSlot('test-deployment', 'custom', 'RUNNING', {}, { stackVersionId: 1, slotCap: 99, daemonId: 'synthetic-daemon', table: [] });
    assert.ok(profile);
    await pool.query("UPDATE profiles SET created_at = '2026-09-08T00:00:00.123456Z' WHERE name = $1", [profile.name]);
    return (await profiles.findByName(profile.name))!;
  }
  async function removeProfile(name: string) {
    await pool.query("UPDATE profiles SET status = 'REMOVING' WHERE name = $1", [name]);
    await profiles.deleteByName(name);
  }
  function submission(prepareHook: () => Promise<void> = async () => {}) {
    let posts = 0;
    let prepares = 0;
    const service = new ChequebookSubmission(operations, async () => {
      prepares++; await prepareHook();
      return { context: transferContext, dispose() {}, preflight: async () => {}, send: async () => { posts++; return { transactionHash }; } };
    });
    return { service, counts: () => ({ posts, prepares }) };
  }

  it('generates a new UUID per profile lifetime and refuses editable replacement', async () => {
    const old = await createProfile();
    assert.match(old.instance_id, /^[0-9a-f-]{36}$/);
    const edited = await profiles.updateEditable(old.name, old.kind, { instance_id: '22222222-2222-4222-8222-222222222222' } as never);
    assert.equal(edited?.instance_id, old.instance_id);
    await removeProfile(old.name);
    const replacement = await createProfile();
    assert.equal(replacement.created_at.toISOString(), old.created_at.toISOString());
    assert.notEqual(replacement.instance_id, old.instance_id);
  });

  it('checks generation at admission after a prepared original was replaced under identical timestamp and name', async () => {
    const old = await createProfile();
    const h = submission(async () => { await removeProfile(old.name); await createProfile(); });
    await assert.rejects(h.service.submit(transferIntent({ profileInstanceId: old.instance_id })), /replaced/i);
    assert.deepEqual(h.counts(), { posts: 0, prepares: 1 });
    assert.equal((await pool.query('SELECT COUNT(*) AS count FROM chequebook_operations')).rows[0].count, '0');
  });

  it('replays recorded generation after deletion without preparing and conflicts with a replacement generation', async () => {
    const old = await createProfile();
    const intent = transferIntent({ profileInstanceId: old.instance_id });
    const h = submission();
    const original = await h.service.submit(intent);
    await removeProfile(old.name);
    assert.equal((await h.service.submit(intent)).kind, 'replayed');
    const replacement = await createProfile();
    assert.equal((await h.service.submit({ ...intent, profileInstanceId: replacement.instance_id })).kind, 'conflict');
    assert.equal((await operations.findById(original.operation.id))?.profileInstanceId, old.instance_id);
    assert.deepEqual(h.counts(), { posts: 1, prepares: 1 });
  });

  it('keeps a historical NULL generation without inferring the current profile and preserves recovery reads', async () => {
    const profile = await createProfile();
    const { operation } = await operations.admit(operationCandidate({ profileInstanceId: profile.instance_id }));
    await pool.query('UPDATE chequebook_operations SET profile_instance_id = NULL WHERE id = $1', [operation.id]);
    const historical = await operations.findWithResponses(operation.id);
    assert.equal(historical?.operation.profileInstanceId, null);
    const recorded = await operations.recordSubmission(operation.id, { state: 'unknown', transactionHash: null, failureReason: 'response_unavailable' });
    assert.equal(recorded.profileInstanceId, null);
    assert.equal(recorded.state, 'unknown');
    await assert.rejects(operations.admit(operationCandidate({ profileInstanceId: null } as never)), /generation/i);
  });
});
