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
    const profile = await profiles.insertWithFreeSlot('test-deployment', 'custom', 'RUNNING', {}, { stackVersionId: 1, maxSlot: 99 });
    assert.ok(profile);
    await pool.query("UPDATE profiles SET created_at = '2026-09-08T00:00:00.123456Z' WHERE name = $1", [profile.name]);
    return (await profiles.findByName(profile.name))!;
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
    assert.match(old.generation_id, /^[0-9a-f-]{36}$/);
    const edited = await profiles.updateEditable(old.name, old.kind, { generation_id: '22222222-2222-4222-8222-222222222222' } as never);
    assert.equal(edited?.generation_id, old.generation_id);
    await profiles.remove(old.name);
    const replacement = await createProfile();
    assert.equal(replacement.created_at.toISOString(), old.created_at.toISOString());
    assert.notEqual(replacement.generation_id, old.generation_id);
  });

  it('checks generation at admission after a prepared original was replaced under identical timestamp and name', async () => {
    const old = await createProfile();
    const h = submission(async () => { await profiles.remove(old.name); await createProfile(); });
    await assert.rejects(h.service.submit(transferIntent({ profileGeneration: old.generation_id })), /replaced/i);
    assert.deepEqual(h.counts(), { posts: 0, prepares: 1 });
    assert.equal((await pool.query('SELECT COUNT(*) AS count FROM chequebook_operations')).rows[0].count, '0');
  });

  it('replays recorded generation after deletion without preparing and conflicts with a replacement generation', async () => {
    const old = await createProfile();
    const intent = transferIntent({ profileGeneration: old.generation_id });
    const h = submission();
    const original = await h.service.submit(intent);
    await profiles.remove(old.name);
    assert.equal((await h.service.submit(intent)).kind, 'replayed');
    const replacement = await createProfile();
    assert.equal((await h.service.submit({ ...intent, profileGeneration: replacement.generation_id })).kind, 'conflict');
    assert.equal((await operations.findById(original.operation.id))?.profileGeneration, old.generation_id);
    assert.deepEqual(h.counts(), { posts: 1, prepares: 1 });
  });

  it('keeps a historical NULL generation without inferring the current profile and preserves recovery reads', async () => {
    const profile = await createProfile();
    const { operation } = await operations.admit(operationCandidate({ profileGeneration: profile.generation_id }));
    await pool.query('UPDATE chequebook_operations SET profile_generation_id = NULL WHERE id = $1', [operation.id]);
    const historical = await operations.findWithResponses(operation.id);
    assert.equal(historical?.operation.profileGeneration, null);
    const recorded = await operations.recordSubmission(operation.id, { state: 'unknown', transactionHash: null, failureReason: 'response_unavailable' });
    assert.equal(recorded.profileGeneration, null);
    assert.equal(recorded.state, 'unknown');
    await assert.rejects(operations.admit(operationCandidate({ profileGeneration: null } as never)), /generation/i);
  });
});
