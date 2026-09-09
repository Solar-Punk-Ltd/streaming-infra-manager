import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChequebookReceiptObservation } from '@streaming-infra-manager/common';
import { chequebookAssertionConfirmation } from '@streaming-infra-manager/common';
import { ChequebookRecovery } from '../../src/domain/chequebook/ChequebookRecovery.js';
import { ChequebookRecoveryInspector } from '../../src/domain/chequebook/ChequebookRecoveryInspector.js';
import { ChequebookReceiptCheck } from '../../src/domain/chequebook/ChequebookReceiptCheck.js';
import { InMemoryChequebookOperations, operationCandidate, transactionHash } from '../support/chequebookOperations.js';
import type { ChainTransaction } from '../../src/domain/chequebook/chainEvidence.js';

const tokenAddress = '0xdbf3ea6f5bee45c02255b2c26a16f300502f68da';
async function setup() {
  const repository = new InMemoryChequebookOperations();
  const admitted = await repository.admit(operationCandidate({ tokenAddress }));
  await repository.claimDispatch(admitted.operation.id);
  const operation = await repository.recordSubmission(admitted.operation.id, { state: 'unknown', transactionHash: null, failureReason: 'response_unavailable' });
  const transaction: ChainTransaction = { hash: transactionHash, chainId: 100, from: operation.nodeAddress, to: tokenAddress,
    data: `0xa9059cbb${operation.chequebookAddress.slice(2).padStart(64, '0')}${BigInt(operation.amountPlur).toString(16).padStart(64, '0')}`,
    nonce: '9', value: '0', blockNumber: null, blockHash: null };
  const header = { number: operation.startBlockNumber, hash: operation.startBlockHash, parentHash: `0x${'88'.repeat(32)}` };
  let scans = 0;
  let lookups = 0;
  let pending: string[] = [];
  let receipt: ChequebookReceiptObservation = { kind: 'pending', reason: 'awaiting_receipt' };
  const reader = {
    async chainId() { return 100; },
    async transaction(hash: string) { lookups++; return hash === transaction.hash ? transaction : null; },
    async blockHeader() { return header; },
    async blockTransactions() { scans++; return { ...header, transactions: [] }; },
  };
  const inspector = new ChequebookRecoveryInspector(async () => reader, async () => pending);
  const receipts = new ChequebookReceiptCheck(repository, async () => receipt);
  const service = new ChequebookRecovery(repository, inspector, receipts);
  return { repository, operation, transaction, reader, service, inspector, receipts, counts: () => ({ scans, lookups }),
    setPending(value: string[]) { pending = value; }, setReceipt(value: ChequebookReceiptObservation) { receipt = value; } };
}

describe('durable transfer recovery coordination', () => {
  it('adopts a manual pending hash without sending or releasing the node', async () => {
    const f = await setup();
    const result = await f.service.resolve(f.operation.id, transactionHash);
    assert.equal(result.state, 'submitted');
    assert.equal(result.receiptObservation?.kind, 'pending');
    assert.equal((await f.repository.admit(operationCandidate())).kind, 'busy');
    assert.deepEqual(f.counts(), { scans: 0, lookups: 1 });
  });

  it('requires full identity and only the receipt checker may settle or revert', async () => {
    const f = await setup();
    const wrong = await f.service.resolve(f.operation.id, `0x${'99'.repeat(32)}`);
    assert.equal(wrong.state, 'unknown');
    assert.equal(wrong.transactionHash, null);
    f.setReceipt({ kind: 'reverted', receiptBlockNumber: '501', receiptBlockHash: `0x${'66'.repeat(32)}`, finalizedBlockNumber: '502', finalizedBlockHash: `0x${'77'.repeat(32)}` });
    assert.equal((await f.service.resolve(f.operation.id, transactionHash)).state, 'reverted');
    assert.equal((await f.repository.admit(operationCandidate())).kind, 'admitted');
  });

  it('continues to a chain scan when a pending candidate belongs equally to historical A', async () => {
    const f = await setup();
    const searched = await f.service.recover(f.operation.id);
    const audit = { actor: 'authenticated-operator', amountPlur: f.operation.amountPlur, confirmation: chequebookAssertionConfirmation(f.operation.amountPlur) };
    await f.service.assertNoSubmission(searched.id, audit, searched.revision);
    const b = (await f.repository.admit(operationCandidate({ tokenAddress }))).operation;
    await f.repository.claimDispatch(b.id);
    await f.repository.recordSubmission(b.id, { state: 'unknown', transactionHash: null, failureReason: 'response_unavailable' });
    f.setPending([transactionHash]);
    const recovered = await f.service.recover(b.id);
    assert.equal(recovered.state, 'unknown');
    assert.equal(recovered.recoveryObservation?.kind, 'ambiguous');
    assert.equal(recovered.recoveryObservation?.scan?.complete, true);
    assert.equal(f.counts().scans, 2);
    await assert.rejects(f.service.assertNoSubmission(b.id, audit, recovered.revision), /search/i);
    assert.equal((await f.repository.admit(operationCandidate())).kind, 'busy');
  });

  it('keeps newer recovery when a stale manual lookup finishes after assertion', async () => {
    const f = await setup();
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>(resolve => { started = resolve; });
    const original = f.reader.transaction;
    f.reader.transaction = async hash => { started(); await new Promise<void>(resolve => { release = resolve; }); return original(hash); };
    const old = f.service.resolve(f.operation.id, transactionHash);
    await pending;
    const checked = await f.service.recover(f.operation.id);
    const asserted = await f.service.assertNoSubmission(checked.id, { actor: 'operator', amountPlur: f.operation.amountPlur, confirmation: chequebookAssertionConfirmation(f.operation.amountPlur) }, checked.revision);
    release();
    assert.deepEqual(await old, asserted);
    assert.equal((await f.repository.findById(asserted.id))?.state, 'asserted');
  });

  it('binds assertion to the reviewed revision at the final recovery load', async () => {
    const f = await setup();
    const checked = await f.service.recover(f.operation.id);
    const newer = await f.service.recover(f.operation.id);
    const input = { actor: 'operator', amountPlur: checked.amountPlur, confirmation: chequebookAssertionConfirmation(checked.amountPlur) };
    await assert.rejects(f.service.assertNoSubmission(checked.id, input, checked.revision),
      error => error instanceof Error && error.name === 'ChequebookOperationChangedError' && error.cause === undefined);
    assert.deepEqual(await f.repository.findById(checked.id), newer);
    const asserted = await f.service.assertNoSubmission(checked.id, input, newer.revision);
    assert.equal(asserted.state, 'asserted');
    assert.deepEqual(Object.keys(asserted.assertion!).sort(), ['actor', 'amountPlur', 'assertedAt', 'confirmation']);
  });

  it('preserves the fixed changed-operation error when a same-account assertion wins after load', async () => {
    const f = await setup();
    const checked = await f.service.recover(f.operation.id);
    const input = { actor: 'operator', amountPlur: checked.amountPlur, confirmation: chequebookAssertionConfirmation(checked.amountPlur) };
    const apply = f.repository.assertNoSubmission.bind(f.repository);
    f.repository.assertNoSubmission = async (expected, audit) => {
      await apply(expected, audit);
      return apply(expected, audit);
    };
    await assert.rejects(f.service.assertNoSubmission(checked.id, input, checked.revision),
      error => error instanceof Error && error.name === 'ChequebookOperationChangedError' && error.cause === undefined);
    const current = await f.repository.findById(checked.id);
    assert.equal(current?.state, 'asserted');
    assert.equal(current?.revision, String(BigInt(checked.revision) + 1n));
  });

  it('returns fixed errors for storage failures and never logs endpoint diagnostics', async () => {
    const f = await setup();
    f.repository.findById = async () => { throw new Error('synthetic-private-path'); };
    await assert.rejects(f.service.recover(f.operation.id), error => error instanceof Error && error.name === 'ChequebookJournalError' && !error.message.includes('synthetic-private-path'));
  });

  it('refuses malformed hashes before observing and leaves conflicted operations untouched', async () => {
    const f = await setup();
    await assert.rejects(f.service.resolve(f.operation.id, 'not-a-hash'), /invalid/i);
    assert.equal(f.counts().lookups, 0);
    const conflicted = { ...f.operation, failureReason: 'hash_conflict' as const };
    f.repository.rows.set(f.operation.id, conflicted);
    assert.deepEqual(await f.service.resolve(f.operation.id, transactionHash), conflicted);
    assert.deepEqual(await f.service.recover(f.operation.id), conflicted);
    assert.equal(f.counts().lookups, 0);
  });

  it('bounds a manual lookup even when an adapter ignores cancellation', async () => {
    const f = await setup();
    const inspector = new ChequebookRecoveryInspector(async () => new Promise(() => {}), async () => [], { timeoutMs: 15 });
    const service = new ChequebookRecovery(f.repository, inspector, f.receipts);
    assert.equal((await service.resolve(f.operation.id, transactionHash)).recoveryObservation?.kind, 'could_not_check');
    assert.equal((await f.repository.admit(operationCandidate())).kind, 'busy');
  });
});
