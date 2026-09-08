import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChequebookReceiptCheck } from '../../src/domain/chequebook/ChequebookReceiptCheck.js';
import type { ChequebookReceiptObservation } from '@streaming-infra-manager/common';
import { InMemoryChequebookOperations, operationCandidate, transactionHash } from '../support/chequebookOperations.js';

const confirmed: ChequebookReceiptObservation = {
  kind: 'settled', receiptBlockNumber: '501', receiptBlockHash: `0x${'77'.repeat(32)}`,
  finalizedBlockNumber: '510', finalizedBlockHash: `0x${'88'.repeat(32)}`,
};

async function setup() {
  const repository = new InMemoryChequebookOperations();
  const { operation } = await repository.admit(operationCandidate());
  const submitted = await repository.recordSubmission(operation.id, { state: 'submitted', transactionHash, failureReason: null });
  return { repository, submitted };
}

describe('durable chequebook receipt checks', () => {
  it('returns the persisted result and supplies only the frozen transfer to its inspector', async () => {
    const { repository, submitted } = await setup();
    const check = new ChequebookReceiptCheck(repository, async operation => {
      assert.equal(operation.transactionHash, transactionHash);
      assert.equal(operation.nodeAddress, submitted.nodeAddress);
      assert.equal(operation.amountPlur, submitted.amountPlur);
      assert.ok(Object.isFrozen(operation));
      return confirmed;
    });
    const result = await check.check(submitted.id);
    assert.equal(result.state, 'settled');
    assert.deepEqual(await repository.findById(submitted.id), result);
  });

  it('keeps a newer failed observation when an older success resumes late', async () => {
    const { repository, submitted } = await setup();
    let release!: (value: ChequebookReceiptObservation) => void;
    let started!: () => void;
    const observing = new Promise<void>(resolve => { started = resolve; });
    const oldCheck = new ChequebookReceiptCheck(repository, async () => {
      started();
      return new Promise(resolve => { release = resolve; });
    });
    const old = oldCheck.check(submitted.id);
    await observing;
    const newer = await new ChequebookReceiptCheck(repository, async () => ({ kind: 'could_not_check', reason: 'chain_changed' })).check(submitted.id);
    release(confirmed);
    assert.deepEqual(await old, newer);
    assert.equal(newer.state, 'submitted');
  });

  it('does not inspect unknown submissions or already terminal records', async () => {
    const { repository, submitted } = await setup();
    let calls = 0;
    const check = new ChequebookReceiptCheck(repository, async () => { calls++; return confirmed; });
    await check.check(submitted.id);
    await check.check(submitted.id);
    const { operation } = await repository.admit(operationCandidate());
    const unknown = await repository.recordSubmission(operation.id, { state: 'unknown', transactionHash: null, failureReason: 'response_unavailable' });
    assert.deepEqual(await check.check(unknown.id), unknown);
    assert.equal(calls, 1);
  });

  it('persists unexpected inspector failure as could not check without releasing protection', async () => {
    const { repository, submitted } = await setup();
    const check = new ChequebookReceiptCheck(repository, async () => { throw new Error('synthetic-private-path'); });
    const result = await check.check(submitted.id);
    assert.equal(result.state, 'submitted');
    assert.deepEqual(result.receiptObservation, { kind: 'could_not_check', reason: 'rpc_unavailable' });
    assert.ok(!JSON.stringify(result).includes('synthetic-private-path'));
  });

  it('never answers settlement when its journal write fails', async () => {
    const { repository, submitted } = await setup();
    repository.recordReceipt = async () => { throw new Error('synthetic-private-path'); };
    await assert.rejects(new ChequebookReceiptCheck(repository, async () => confirmed).check(submitted.id), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, 'ChequebookJournalError');
      assert.ok(!error.message.includes('synthetic-private-path'));
      return true;
    });
    assert.equal((await repository.findById(submitted.id))?.state, 'submitted');
  });
});
