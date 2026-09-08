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

  const confirmed = {
    kind: 'settled' as const, receiptBlockNumber: '501', receiptBlockHash: `0x${'77'.repeat(32)}`,
    finalizedBlockNumber: '510', finalizedBlockHash: `0x${'88'.repeat(32)}`,
  };

  async function submittedOperation() {
    const { operation } = await repository.admit(operationCandidate());
    await repository.claimDispatch(operation.id);
    return repository.recordSubmission(operation.id, { state: 'submitted', transactionHash, failureReason: null });
  }

  it('persists receipt checks across restart and releases the node only after confirmation', async () => {
    const submitted = await submittedOperation();
    assert.equal(submitted.revision, '2');
    const pending = await repository.recordReceipt(submitted, { kind: 'pending', reason: 'awaiting_finality' });
    assert.equal(pending.state, 'submitted');
    assert.equal(pending.revision, '3');
    assert.equal((await repository.admit(operationCandidate())).kind, 'busy');
    const settled = await new PostgresChequebookOperationRepository(pool).recordReceipt(pending, confirmed);
    assert.equal(settled.state, 'settled');
    assert.equal(settled.revision, '4');
    const loaded = await new PostgresChequebookOperationRepository(pool).findById(settled.id);
    assert.deepEqual(loaded?.receiptObservation, confirmed);
    assert.ok(loaded?.receiptCheckedAt);
    assert.equal((await repository.admit(operationCandidate())).kind, 'admitted');
    assert.equal((await repository.admit(operationCandidate({ ...settled }))).kind, 'replayed');
  });

  it('rejects a stale success after another manager persisted a failed check', async () => {
    const firstSnapshot = await submittedOperation();
    const secondRepository = new PostgresChequebookOperationRepository(pool);
    const secondSnapshot = await secondRepository.findById(firstSnapshot.id);
    assert.ok(secondSnapshot);
    const newer = await secondRepository.recordReceipt(secondSnapshot, { kind: 'could_not_check', reason: 'chain_changed' });
    const stale = await repository.recordReceipt(firstSnapshot, confirmed);
    assert.deepEqual(stale, newer);
    assert.equal(stale.state, 'submitted');
    assert.equal((await repository.admit(operationCandidate())).kind, 'busy');
    const retry = await repository.recordReceipt(await repository.findById(stale.id).then(row => row!), confirmed);
    assert.equal(retry.state, 'settled');
  });

  it('accepts only one observation from concurrent checks at the same revision', async () => {
    const submitted = await submittedOperation();
    const results = await Promise.all(Array.from({ length: 12 }, () => new PostgresChequebookOperationRepository(pool)
      .recordReceipt(submitted, { kind: 'pending', reason: 'awaiting_finality' })));
    assert.ok(results.every(row => row.revision === '3'));
    assert.equal((await repository.findById(submitted.id))?.revision, '3');
  });

  it('binds observations to the known hash and an unresolved submitted row', async () => {
    const submitted = await submittedOperation();
    const otherHash = `0x${'99'.repeat(32)}`;
    assert.deepEqual(await repository.recordReceipt({ ...submitted, transactionHash: otherHash }, confirmed), submitted);
    const reverted = await repository.recordReceipt(submitted, { ...confirmed, kind: 'reverted' });
    assert.equal(reverted.state, 'reverted');
    assert.deepEqual(await repository.recordReceipt(reverted, { kind: 'could_not_check', reason: 'rpc_unavailable' }), reverted);
    const unknown = await repository.admit(operationCandidate());
    const unresolved = await repository.recordSubmission(unknown.operation.id, { state: 'unknown', transactionHash: null, failureReason: 'response_unavailable' });
    assert.deepEqual(await repository.recordReceipt({ ...unresolved, transactionHash }, confirmed), unresolved);
  });

  it('refuses malformed confirmation and whitelists persisted observation fields', async () => {
    const submitted = await submittedOperation();
    for (const evidence of [
      { ...confirmed, receiptBlockHash: 'synthetic-private-path' },
      { ...confirmed, finalizedBlockNumber: '500' },
      { ...confirmed, finalizedBlockNumber: '501' },
      { ...confirmed, receiptBlockNumber: '01' },
    ]) await assert.rejects(repository.recordReceipt(submitted, evidence), /invalid/i);
    assert.deepEqual(await repository.findById(submitted.id), submitted);
    const result = await repository.recordReceipt(submitted, { ...confirmed, endpoint: 'synthetic-private-path' } as typeof confirmed);
    assert.deepEqual(result.receiptObservation, confirmed);
    assert.ok(!JSON.stringify(result).includes('synthetic-private-path'));
  });

  it('retains whitelisted history checkpoints across repository restart and rejects stale cursor writes', async () => {
    const submitted = await submittedOperation();
    const history = {
      transactionHash, receiptBlockNumber: '501', receiptBlockHash: confirmed.receiptBlockHash, receiptStatus: 'success' as const,
      finalizedBlockNumber: '510', finalizedBlockHash: confirmed.finalizedBlockHash,
      cursorBlockNumber: '508', cursorBlockHash: `0x${'11'.repeat(32)}`,
    };
    const partial = await repository.recordReceipt(submitted, {
      kind: 'could_not_check', reason: 'history_incomplete', history: { ...history, endpoint: 'synthetic-private-path' } as typeof history,
    });
    const restarted = new PostgresChequebookOperationRepository(pool);
    const saved = await restarted.findById(partial.id);
    assert.deepEqual(saved?.receiptObservation, { kind: 'could_not_check', reason: 'history_incomplete', history });
    assert.ok(!JSON.stringify(saved).includes('synthetic-private-path'));
    assert.equal((await restarted.admit(operationCandidate())).kind, 'busy');
    const next = await restarted.recordReceipt(partial, {
      kind: 'could_not_check', reason: 'rpc_unavailable', history: { ...history, cursorBlockNumber: '506' },
    });
    assert.deepEqual(await repository.recordReceipt(partial, partial.receiptObservation!), next);
    assert.deepEqual((await repository.findById(partial.id))?.receiptObservation, next.receiptObservation);
  });

  it('rejects contradictory checkpoint bounds and status without changing its journal', async () => {
    const submitted = await submittedOperation();
    const history = {
      transactionHash, receiptBlockNumber: '501', receiptBlockHash: confirmed.receiptBlockHash, receiptStatus: 'success' as const,
      finalizedBlockNumber: '510', finalizedBlockHash: confirmed.finalizedBlockHash,
      cursorBlockNumber: '508', cursorBlockHash: `0x${'11'.repeat(32)}`,
    };
    for (const changes of [
      { cursorBlockNumber: '511' }, { receiptBlockNumber: '511' }, { cursorBlockNumber: '501' },
      { cursorBlockNumber: '510' }, { receiptStatus: 'invalid' }, { cursorBlockHash: 'synthetic-private-path' },
    ]) {
      await assert.rejects(repository.recordReceipt(submitted, {
        kind: 'could_not_check', reason: 'history_incomplete', history: { ...history, ...changes } as typeof history,
      }), /invalid/i);
    }
    await assert.rejects(repository.recordReceipt(submitted, { kind: 'could_not_check', reason: 'chain_changed', history }), /invalid/i);
    assert.deepEqual(await repository.findById(submitted.id), submitted);
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
