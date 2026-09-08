import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { PostgresChequebookOperationRepository } from '../../src/domain/chequebook/PostgresChequebookOperationRepository.js';
import { ChequebookSubmission } from '../../src/domain/chequebook/ChequebookSubmission.js';
import { operationCandidate, transactionHash, transferContext, transferIntent } from '../support/chequebookOperations.js';

const port = Number(process.env.T09_TEST_PG_PORT);
// Only a loopback port is configurable. This suite cannot select a deployment database.
const connection = { host: '127.0.0.1', port, user: 'postgres', database: 't09_test', connectionTimeoutMillis: 30000 };

describe('chequebook operations in isolated PostgreSQL schemas', { skip: !Number.isInteger(port) || port < 1 || port > 65535 }, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let repository: PostgresChequebookOperationRepository;
  beforeEach(async () => {
    schema = `t09_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 20, options: `-c search_path=${schema}` });
    const migrations = new URL('../../src/migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(name, migrations), 'utf8'));
    }
    repository = new PostgresChequebookOperationRepository(pool);
  });
  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('persists the full identity without requiring a surviving profile row', async () => {
    const candidate = operationCandidate();
    const admitted = await repository.admit(candidate);
    assert.equal(admitted.kind, 'admitted');
    const restarted = new PostgresChequebookOperationRepository(pool);
    const row = await restarted.findById(candidate.id);
    for (const [key, value] of Object.entries(candidate)) assert.equal(row?.[key as keyof typeof row], value);
    assert.equal(row?.state, 'submitting');
    assert.ok(row?.createdAt);
    assert.equal((await restarted.findByRequestId(candidate.requestId))?.id, candidate.id);
  });

  it('admits only one concurrent request across aliases and repository instances', async () => {
    const replies = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      new PostgresChequebookOperationRepository(pool).admit(operationCandidate({ profileName: `alias-${index}`, direction: index % 2 ? 'deposit' : 'withdraw', nodeAddress: index % 2 ? transferContext.nodeAddress : transferContext.nodeAddress.toUpperCase().replace('0X', '0x') })),
    ));
    assert.equal(replies.filter(reply => reply.kind === 'admitted').length, 1);
    assert.equal(replies.filter(reply => reply.kind === 'busy').length, 19);
    assert.equal(new Set(replies.map(reply => reply.operation.id)).size, 1);
    assert.equal((await pool.query('SELECT * FROM chequebook_operations')).rowCount, 1);
  });

  it('deduplicates one request submitted concurrently with different observed contexts', async () => {
    const candidate = operationCandidate();
    const replies = await Promise.all(Array.from({ length: 12 }, (_, index) => repository.admit(operationCandidate({ ...candidate, startBlockNumber: String(500 + index), nonceLowerBound: String(8 + index) }))));
    assert.equal(replies.filter(reply => reply.kind === 'admitted').length, 1);
    assert.equal(replies.filter(reply => reply.kind === 'replayed').length, 11);
    assert.equal(new Set(replies.map(reply => reply.operation.nonceLowerBound)).size, 1);
  });

  it('keeps request keys unique after terminal settlement and refuses a changed intent', async () => {
    const candidate = operationCandidate();
    await repository.admit(candidate);
    await pool.query("UPDATE chequebook_operations SET state = 'settled', transaction_hash = $2 WHERE id = $1", [candidate.id, transactionHash]);
    assert.equal((await repository.admit(operationCandidate({ ...candidate }))).kind, 'replayed');
    assert.equal((await repository.admit(operationCandidate({ ...candidate, amountPlur: '1' }))).kind, 'conflict');
    assert.equal((await repository.admit(operationCandidate())).kind, 'admitted');
  });

  it('separates chains and nodes without weakening the same-node guard', async () => {
    await repository.admit(operationCandidate());
    assert.equal((await repository.admit(operationCandidate({ chainId: 1 }))).kind, 'admitted');
    assert.equal((await repository.admit(operationCandidate({ nodeAddress: `0x${'ff'.repeat(20)}` }))).kind, 'admitted');
    assert.equal((await repository.admit(operationCandidate())).kind, 'busy');
  });

  it('does not overwrite a concurrently verified outcome with a late submission failure', async () => {
    const candidate = operationCandidate();
    await repository.admit(candidate);
    await pool.query("UPDATE chequebook_operations SET state = 'settled', transaction_hash = $2 WHERE id = $1", [candidate.id, transactionHash]);
    const result = await repository.recordSubmission(candidate.id, { state: 'unknown', transactionHash: null, failureReason: 'response_unavailable' });
    assert.equal(result.state, 'settled');
    assert.equal(result.transactionHash, transactionHash);
  });

  it('persists a lost response and keeps concurrent restarted coordinators from replaying', async () => {
    let submissions = 0;
    const intent = transferIntent();
    const service = () => new ChequebookSubmission(new PostgresChequebookOperationRepository(pool), async () => ({ context: transferContext, preflight: async () => {}, send: async () => { submissions++; throw new Error('lost response'); } }));
    const first = await service().submit(intent);
    assert.equal(first.operation.state, 'unknown');
    const retries = await Promise.all(Array.from({ length: 8 }, () => service().submit(intent)));
    assert.ok(retries.every(result => result.kind === 'replayed' && result.operation.state === 'unknown'));
    assert.equal((await service().submit(transferIntent())).kind, 'busy');
    assert.equal(submissions, 1);
  });

  it('never sends after admission committed but its response was lost', async () => {
    const intent = transferIntent();
    let submissions = 0;
    const prepare = async () => ({ context: transferContext, preflight: async () => {}, send: async () => { submissions++; return { transactionHash }; } });
    const admit = repository.admit.bind(repository);
    repository.admit = async candidate => {
      await admit(candidate);
      throw new Error('commit response lost');
    };
    await assert.rejects(new ChequebookSubmission(repository, prepare).submit(intent), /journal/i);
    const restarted = new ChequebookSubmission(new PostgresChequebookOperationRepository(pool), prepare);
    const retry = await restarted.submit(intent);
    assert.equal(retry.kind, 'replayed');
    assert.equal(retry.operation.state, 'submitting');
    assert.equal((await restarted.submit(transferIntent())).kind, 'busy');
    assert.equal(submissions, 0);
  });

  it('allows exactly one Bee POST from competing coordinators', async () => {
    let submissions = 0;
    const service = () => new ChequebookSubmission(new PostgresChequebookOperationRepository(pool), async () => ({ context: transferContext, preflight: async () => {}, send: async () => { submissions++; return { transactionHash }; } }));
    const replies = await Promise.all(Array.from({ length: 12 }, (_, index) => service().submit(transferIntent({ profileName: `alias-${index}` }))));
    assert.equal(replies.filter(result => result.kind === 'admitted').length, 1);
    assert.equal(replies.filter(result => result.kind === 'busy').length, 11);
    assert.equal(submissions, 1);
  });

  it('preserves a recovered pending hash against late submission results', async () => {
    const candidate = operationCandidate();
    await repository.admit(candidate);
    const recoveredHash = `0x${'de'.repeat(32)}`;
    await pool.query("UPDATE chequebook_operations SET state = 'submitted', transaction_hash = $2 WHERE id = $1", [candidate.id, recoveredHash]);
    const lateSuccess = await repository.recordSubmission(candidate.id, { state: 'submitted', transactionHash, failureReason: null });
    assert.equal(lateSuccess.transactionHash, recoveredHash);
    const lateFailure = await repository.recordSubmission(candidate.id, { state: 'unknown', transactionHash: null, failureReason: 'response_unavailable' });
    assert.equal(lateFailure.state, 'submitted');
    assert.equal(lateFailure.transactionHash, recoveredHash);
  });

  it('grants dispatch once across managers and refuses it after pre-dispatch closure', async () => {
    const candidate = operationCandidate();
    await repository.admit(candidate);
    const claims = await Promise.all(Array.from({ length: 10 }, () => new PostgresChequebookOperationRepository(pool).claimDispatch(candidate.id)));
    assert.equal(claims.filter(claim => claim.claimed).length, 1);
    assert.ok(claims.every(claim => claim.operation.dispatchStartedAt));
    await pool.query("UPDATE chequebook_operations SET state = 'asserted' WHERE id = $1", [candidate.id]);
    const next = operationCandidate();
    await repository.admit(next);
    await pool.query("UPDATE chequebook_operations SET state = 'asserted' WHERE id = $1", [next.id]);
    const closed = await repository.claimDispatch(next.id);
    assert.equal(closed.claimed, false);
    assert.equal(closed.operation.dispatchStartedAt, null);
  });

  it('enforces the same-node uniqueness in SQL even when admission code is bypassed', async () => {
    await repository.admit(operationCandidate());
    await assert.rejects(pool.query(`INSERT INTO chequebook_operations
      (id, request_id, profile_name, requested_by, direction, amount_plur, chain_id, node_address, chequebook_address, token_address, start_block_number, start_block_hash, nonce_lower_bound, nonce_query_tag)
      SELECT gen_random_uuid(), gen_random_uuid(), profile_name, requested_by, direction, amount_plur, chain_id, node_address, chequebook_address, token_address, start_block_number, start_block_hash, nonce_lower_bound, nonce_query_tag FROM chequebook_operations`), (error: unknown) => (error as { code?: string }).code === '23505');
  });
});
