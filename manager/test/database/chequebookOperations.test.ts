import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';
import { PostgresChequebookOperationRepository } from '../../src/domain/chequebook/PostgresChequebookOperationRepository.js';
import { ChequebookRecovery } from '../../src/domain/chequebook/ChequebookRecovery.js';
import { ChequebookRecoveryInspector } from '../../src/domain/chequebook/ChequebookRecoveryInspector.js';
import { ChequebookReceiptCheck } from '../../src/domain/chequebook/ChequebookReceiptCheck.js';
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

  const tokenAddress = '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da';
  const noMatch = {
    kind: 'no_match' as const, candidateHashes: [],
    scan: { headBlockNumber: '500', headBlockHash: transferContext.startBlockHash,
      nextBlockNumber: '500', nextBlockHash: transferContext.startBlockHash, complete: true, candidateHashes: [] },
  };
  const assertion = { actor: 'authenticated-operator', amountPlur: '5000000000000000', confirmation: 'I accept that retrying 0.5 BZZ may pay twice.' };
  function recoveryTransaction(overrides = {}) {
    return { hash: transactionHash, chainId: 100, from: transferContext.nodeAddress, to: tokenAddress,
      data: `0xa9059cbb${transferContext.chequebookAddress.slice(2).padStart(64, '0')}${BigInt(assertion.amountPlur).toString(16).padStart(64, '0')}`,
      nonce: '9', value: '0', blockNumber: null, blockHash: null, ...overrides };
  }
  async function unknownOperation(dispatch = true) {
    const { operation } = await repository.admit(operationCandidate({ tokenAddress }));
    if (dispatch) await repository.claimDispatch(operation.id);
    return repository.recordSubmission(operation.id, { state: 'unknown', transactionHash: null, failureReason: 'response_unavailable' });
  }
  async function assertedOperation(dispatch = true) {
    const unknown = await unknownOperation(dispatch);
    const checked = await repository.recordRecovery(unknown, noMatch, []);
    return repository.assertNoSubmission(checked, assertion);
  }

  it('requires current complete no-match evidence and exact typed risk before assertion', async () => {
    const unknown = await unknownOperation();
    await assert.rejects(repository.assertNoSubmission(unknown, assertion), /search/i);
    const checked = await repository.recordRecovery(unknown, noMatch, []);
    await assert.rejects(repository.assertNoSubmission(checked, { ...assertion, amountPlur: '1' }), /invalid/i);
    await assert.rejects(repository.assertNoSubmission(checked, { ...assertion, confirmation: 'I agree' }), /invalid/i);
    const newer = await repository.recordRecovery(checked, { kind: 'could_not_check', reason: 'rpc_unavailable', candidateHashes: [] }, []);
    assert.deepEqual(await repository.assertNoSubmission(checked, assertion), newer);
    await assert.rejects(repository.assertNoSubmission(newer, assertion), /search/i);
    const rechecked = await repository.recordRecovery(newer, noMatch, []);
    const asserted = await repository.assertNoSubmission(rechecked, assertion);
    assert.equal(asserted.state, 'asserted');
    assert.deepEqual(asserted.assertion, { ...assertion, assertedAt: asserted.assertion?.assertedAt });
    assert.ok(asserted.assertion?.assertedAt);
    assert.equal(asserted.transactionHash, null);
    assert.equal((await repository.admit(operationCandidate())).kind, 'admitted');
  });

  it('never automatically or manually attributes a late transfer shared by asserted A and open B', async () => {
    const a = await assertedOperation();
    const b = await unknownOperation();
    const candidate = recoveryTransaction();
    const observed = { kind: 'candidate' as const, candidateHashes: [transactionHash] };
    const automatic = await repository.recordRecovery(b, observed, [candidate]);
    assert.equal(automatic.transactionHash, null);
    assert.equal(automatic.recoveryObservation?.kind, 'ambiguous');
    const manual = await repository.resolveCandidate(automatic, candidate);
    assert.equal(manual.transactionHash, null);
    await assert.rejects(repository.assertNoSubmission(manual, assertion), /search/i);
    assert.equal((await repository.admit(operationCandidate())).kind, 'busy');
    assert.equal((await repository.findById(a.id))?.state, 'asserted');
  });

  it('excludes a never-dispatched predecessor while retaining a matching pending hash as protected', async () => {
    await assertedOperation(false);
    const b = await unknownOperation();
    const adopted = await repository.resolveCandidate(b, recoveryTransaction());
    assert.equal(adopted.state, 'submitted');
    assert.equal(adopted.transactionHash, transactionHash);
    assert.equal((await repository.admit(operationCandidate())).kind, 'busy');
  });

  it('retains late direct-response evidence after assertion without settling it or releasing B', async () => {
    const a = await assertedOperation();
    const b = await unknownOperation();
    const late = await repository.recordSubmission(a.id, { state: 'submitted', transactionHash, failureReason: null });
    assert.equal(late.state, 'asserted');
    assert.equal(late.transactionHash, transactionHash);
    assert.deepEqual(late.assertion, a.assertion);
    const evidence = await repository.listSubmissionResponses(a.id);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.transactionHash, transactionHash);
    assert.equal(evidence[0]?.ownership, 'owned');
    const blocked = await repository.resolveCandidate(b, recoveryTransaction());
    assert.equal(blocked.transactionHash, null);
    assert.equal((await repository.admit(operationCandidate())).kind, 'busy');
  });

  it('serializes competing direct hash writers and retains the loser response as evidence', async () => {
    const a = await assertedOperation();
    const b = await unknownOperation();
    const results = await Promise.all([a, b].map(operation => repository.recordSubmission(operation.id, { state: 'submitted', transactionHash, failureReason: null })));
    assert.equal(results.filter(operation => operation.transactionHash === transactionHash).length, 1);
    const rows = await Promise.all([a, b].map(operation => repository.findById(operation.id)));
    assert.equal(rows.filter(operation => operation?.transactionHash === transactionHash).length, 1);
    const evidence = (await Promise.all([a, b].map(operation => repository.listSubmissionResponses(operation.id)))).flat();
    assert.equal(evidence.length, 2);
    assert.deepEqual(evidence.map(item => item.ownership).sort(), ['conflict', 'owned']);
    assert.equal((await repository.findById(a.id))?.state, 'asserted');
    assert.equal((await repository.admit(operationCandidate())).kind, 'busy');
  });

  it('blocks both older and newly started receipt confirmations after contradictory direct evidence', async () => {
    const unknown = await unknownOperation();
    const recovered = await repository.resolveCandidate(unknown, recoveryTransaction());
    const differentHash = `0x${'98'.repeat(32)}`;
    const conflicted = await repository.recordSubmission(recovered.id, { state: 'submitted', transactionHash: differentHash, failureReason: null });
    assert.equal(conflicted.transactionHash, transactionHash);
    assert.equal(conflicted.failureReason, 'hash_conflict');
    assert.equal(conflicted.revision, String(BigInt(recovered.revision) + 1n));
    assert.equal(conflicted.receiptObservation?.kind, 'could_not_check');
    if (conflicted.receiptObservation?.kind === 'could_not_check') assert.equal(conflicted.receiptObservation.reason, 'attribution_conflict');
    assert.deepEqual(await repository.recordReceipt(recovered, confirmed), conflicted);
    assert.deepEqual(await repository.recordReceipt(conflicted, confirmed), conflicted);
    assert.deepEqual(await repository.resolveCandidate(conflicted, recoveryTransaction({ hash: differentHash })), conflicted);
    const evidence = await repository.listSubmissionResponses(recovered.id);
    assert.equal(evidence[0]?.transactionHash, differentHash);
    assert.equal(evidence[0]?.ownership, 'conflict');
    assert.equal((await repository.admit(operationCandidate())).kind, 'busy');
  });

  it('does not clear a conflicting direct response when another submission callback arrives late', async () => {
    const a = await assertedOperation();
    await repository.recordSubmission(a.id, { state: 'submitted', transactionHash, failureReason: null });
    const b = (await repository.admit(operationCandidate({ tokenAddress }))).operation;
    const conflicted = await repository.recordSubmission(b.id, { state: 'submitted', transactionHash, failureReason: null });
    assert.equal(conflicted.failureReason, 'hash_conflict');
    for (const outcome of [
      { state: 'unknown' as const, transactionHash: null, failureReason: 'response_unavailable' as const },
      { state: 'rejected' as const, transactionHash: null, failureReason: 'preflight_failed' as const },
    ]) assert.deepEqual(await repository.recordSubmission(b.id, outcome), conflicted);
    assert.equal((await repository.admit(operationCandidate())).kind, 'busy');
  });

  it('preserves candidate evidence against unrelated or competing manual hashes and later empty observations', async () => {
    const unknown = await unknownOperation();
    const first = recoveryTransaction();
    const partial = await repository.recordRecovery(unknown, {
      kind: 'searching', candidateHashes: [transactionHash],
      scan: { ...noMatch.scan, complete: false, candidateHashes: [transactionHash] },
    }, [first]);
    const wrong = await repository.resolveCandidate(partial, recoveryTransaction({ hash: `0x${'91'.repeat(32)}`, data: '0x' }));
    assert.deepEqual(wrong.recoveryObservation?.candidateHashes, [transactionHash]);
    assert.equal(wrong.transactionHash, null);
    const other = recoveryTransaction({ hash: `0x${'92'.repeat(32)}`, nonce: '10' });
    const ambiguous = await repository.resolveCandidate(wrong, other);
    assert.equal(ambiguous.transactionHash, null);
    assert.equal(ambiguous.recoveryObservation?.kind, 'ambiguous');
    assert.deepEqual(ambiguous.recoveryObservation?.candidateHashes, [transactionHash, other.hash]);
    const vanished = await repository.recordRecovery(ambiguous, { kind: 'could_not_check', reason: 'rpc_unavailable', candidateHashes: [] }, []);
    assert.deepEqual(vanished.recoveryObservation?.candidateHashes, [transactionHash, other.hash]);
    const empty = await repository.recordRecovery(vanished, noMatch, []);
    assert.notEqual(empty.recoveryObservation?.kind, 'no_match');
    assert.deepEqual(empty.recoveryObservation?.candidateHashes, [transactionHash, other.hash]);
    await assert.rejects(repository.assertNoSubmission(empty, assertion), /search/i);
    assert.equal((await repository.admit(operationCandidate())).kind, 'busy');
  });

  it('resumes the actual recovery service through PostgreSQL restart without skipping blocks or losing ambiguity', async () => {
    const blockHash = (number: number) => number === 500 ? transferContext.startBlockHash : `0x${number.toString(16).padStart(64, '0')}`;
    const first = recoveryTransaction({ blockNumber: '505', blockHash: blockHash(505) });
    const second = recoveryTransaction({ hash: `0x${'93'.repeat(32)}`, nonce: '10', blockNumber: '501', blockHash: blockHash(501) });
    const inspected: string[] = [];
    const reader = {
      async chainId() { return 100; },
      async transaction(hash: string) { return [first, second].find(transaction => transaction.hash === hash) ?? null; },
      async blockHeader(input: bigint | 'latest') {
        const number = input === 'latest' ? 505 : Number(input);
        return { number: String(number), hash: blockHash(number), parentHash: blockHash(number - 1) };
      },
      async blockTransactions(input: bigint) {
        const number = Number(input);
        inspected.push(String(number));
        return { number: String(number), hash: blockHash(number), parentHash: blockHash(number - 1), transactions: [first, second].filter(transaction => transaction.blockNumber === String(number)) };
      },
    };
    const service = () => {
      const restarted = new PostgresChequebookOperationRepository(pool);
      const inspector = new ChequebookRecoveryInspector(async () => reader, async () => [], { maxBlocks: 2 });
      const receipts = new ChequebookReceiptCheck(restarted, async () => { assert.fail('Ambiguous transfers must never reach receipt confirmation'); });
      return new ChequebookRecovery(restarted, inspector, receipts);
    };
    const unknown = await unknownOperation();
    const chunk1 = await service().recover(unknown.id);
    assert.equal(chunk1.recoveryObservation?.kind, 'searching');
    assert.equal(chunk1.recoveryObservation?.scan?.nextBlockNumber, '503');
    assert.equal((await repository.admit(operationCandidate())).kind, 'busy');
    const chunk2 = await service().recover(unknown.id);
    assert.equal(chunk2.recoveryObservation?.scan?.nextBlockNumber, '501');
    const complete = await service().recover(unknown.id);
    assert.equal(complete.state, 'unknown');
    assert.equal(complete.recoveryObservation?.kind, 'ambiguous');
    assert.deepEqual(complete.recoveryObservation?.candidateHashes, [first.hash, second.hash]);
    assert.deepEqual(inspected, ['505', '504', '503', '502', '501', '500']);
    assert.deepEqual(await repository.findById(unknown.id), complete);
    assert.deepEqual(await repository.recordRecovery(chunk1, noMatch, []), complete);
    await assert.rejects(service().assertNoSubmission(unknown.id, assertion), /search/i);
  });

  it('whitelists saved recovery evidence and rejects malformed bounds without changing a row', async () => {
    const unknown = await unknownOperation();
    for (const scan of [
      { ...noMatch.scan, nextBlockNumber: '499' },
      { ...noMatch.scan, nextBlockHash: `0x${'88'.repeat(32)}` },
      { ...noMatch.scan, headBlockNumber: '499' },
      { ...noMatch.scan, headBlockNumber: '0500' },
    ]) await assert.rejects(repository.recordRecovery(unknown, { ...noMatch, scan }, []), /invalid/i);
    assert.deepEqual(await repository.findById(unknown.id), unknown);
    const input = { ...noMatch, endpoint: 'synthetic-private-path', scan: { ...noMatch.scan, endpoint: 'synthetic-private-path' } };
    const checked = await repository.recordRecovery(unknown, input, []);
    assert.deepEqual(checked.recoveryObservation, noMatch);
    assert.ok(!JSON.stringify(checked).includes('synthetic-private-path'));
  });

  it('keeps a historical conflicting owner in candidate attribution despite its different saved hash', async () => {
    const a = await assertedOperation();
    await repository.recordSubmission(a.id, { state: 'submitted', transactionHash, failureReason: null });
    const differentHash = `0x${'94'.repeat(32)}`;
    await repository.recordSubmission(a.id, { state: 'submitted', transactionHash: differentHash, failureReason: null });
    const b = await unknownOperation();
    const recovered = await repository.resolveCandidate(b, recoveryTransaction({ hash: differentHash }));
    assert.equal(recovered.transactionHash, null);
    assert.equal(recovered.recoveryObservation?.kind, 'ambiguous');
    assert.equal((await repository.admit(operationCandidate())).kind, 'busy');
  });

  it('invalidates the existing owner receipt when a different operation returns that same hash', async () => {
    const a = await assertedOperation();
    const b = await unknownOperation();
    const owned = await repository.recordSubmission(b.id, { state: 'submitted', transactionHash, failureReason: null });
    const late = await repository.recordSubmission(a.id, { state: 'submitted', transactionHash, failureReason: null });
    assert.equal(late.state, 'asserted');
    assert.equal(late.failureReason, 'hash_conflict');
    const owner = await repository.findById(b.id);
    assert.ok(owner);
    assert.equal(owner.failureReason, 'hash_conflict');
    assert.equal(owner.transactionHash, transactionHash);
    assert.equal(owner.revision, String(BigInt(owned.revision) + 1n));
    assert.deepEqual(await repository.recordReceipt(owned, confirmed), owner);
    assert.deepEqual(await repository.recordReceipt(owner, confirmed), owner);
    assert.equal((await repository.admit(operationCandidate())).kind, 'busy');
  });

  it('serializes crossed response conflicts on different nodes without reassigning either owned hash', async () => {
    const a = (await repository.admit(operationCandidate())).operation;
    const b = (await repository.admit(operationCandidate({ nodeAddress: `0x${'98'.repeat(20)}` }))).operation;
    const secondHash = `0x${'95'.repeat(32)}`;
    await repository.recordSubmission(a.id, { state: 'submitted', transactionHash, failureReason: null });
    await repository.recordSubmission(b.id, { state: 'submitted', transactionHash: secondHash, failureReason: null });
    await Promise.all([
      repository.recordSubmission(a.id, { state: 'submitted', transactionHash: secondHash, failureReason: null }),
      repository.recordSubmission(b.id, { state: 'submitted', transactionHash, failureReason: null }),
    ]);
    const first = await repository.findById(a.id);
    const second = await repository.findById(b.id);
    assert.equal(first?.transactionHash, transactionHash);
    assert.equal(second?.transactionHash, secondHash);
    assert.equal(first?.failureReason, 'hash_conflict');
    assert.equal(second?.failureReason, 'hash_conflict');
    assert.equal((await repository.listSubmissionResponses(a.id)).length, 2);
    assert.equal((await repository.listSubmissionResponses(b.id)).length, 2);
  });

  it('enforces hash uniqueness at the database boundary and permits the same hash on a different chain', async () => {
    const a = await submittedOperation();
    await repository.recordReceipt(a, confirmed);
    const b = (await repository.admit(operationCandidate())).operation;
    await assert.rejects(pool.query("UPDATE chequebook_operations SET transaction_hash=$2, state='submitted' WHERE id=$1", [b.id, transactionHash]), { code: '23505' });
    const c = (await repository.admit(operationCandidate({ chainId: 1 }))).operation;
    assert.equal((await repository.recordSubmission(c.id, { state: 'submitted', transactionHash, failureReason: null })).transactionHash, transactionHash);
  });

  it('rejects unrelated manual evidence and prevents stale recovery from changing newer observations', async () => {
    const unknown = await unknownOperation();
    const mismatch = await repository.resolveCandidate(unknown, recoveryTransaction({ nonce: '7' }));
    assert.equal(mismatch.transactionHash, null);
    assert.equal(mismatch.recoveryObservation?.kind, 'could_not_check');
    assert.deepEqual(await repository.recordRecovery(unknown, noMatch, []), mismatch);
    assert.equal((await repository.admit(operationCandidate())).kind, 'busy');
  });

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
