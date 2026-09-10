/**
 * What the page will accept as a manager record.
 *
 * The poll deadline decides whether the page keeps re-reading, so a value it
 * cannot read as a time is worse than no value at all: it would either promise
 * checking that is over or hide checking that is still running. Only null or a
 * real timestamp passes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isTransferOperation } from './transferEvidence';

const operation = {
  id: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222',
  profileName: 'synthetic-test', profileInstanceId: '33333333-3333-4333-8333-333333333333', requestedBy: 'user:7',
  direction: 'deposit', amountPlur: '5000000000000000', state: 'submitted',
  chainId: 100, nodeAddress: `0x${'11'.repeat(20)}`, chequebookAddress: `0x${'22'.repeat(20)}`, tokenAddress: `0x${'33'.repeat(20)}`,
  startBlockNumber: '500', startBlockHash: `0x${'44'.repeat(32)}`, nonceLowerBound: '9', nonceQueryTag: '0x1f4',
  transactionHash: `0x${'55'.repeat(32)}`, failureReason: null, revision: '0', dispatchStartedAt: '2026-09-08T00:00:00.000Z',
  receiptObservation: null, receiptCheckedAt: null, receiptPollUntil: '2026-09-10T14:32:00.000Z',
  recoveryObservation: null, recoveryCheckedAt: null, assertion: null,
  createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
};

describe('isTransferOperation', () => {
  it('accepts a timestamp or null for the poll deadline', () => {
    assert.equal(isTransferOperation(operation), true);
    assert.equal(isTransferOperation({ ...operation, receiptPollUntil: null }), true);
  });

  it('refuses a poll deadline that is missing or is not a time', () => {
    const { receiptPollUntil: _absent, ...without } = operation;
    assert.equal(isTransferOperation(without), false);
    for (const value of ['soon', '', 0, 1_760_000_000_000, false, {}, []]) {
      assert.equal(isTransferOperation({ ...operation, receiptPollUntil: value }), false, `${JSON.stringify(value)} is not a poll deadline`);
    }
  });

  it('refuses anything but the timestamp shape the manager writes', () => {
    for (const value of ['2026', '2026-09', '2026-09-10', 'September 10 2026', '2026-09-10 14:32:00Z', '2026-09-10T14:32:00']) {
      assert.equal(isTransferOperation({ ...operation, receiptPollUntil: value }), false, `${JSON.stringify(value)} is not a poll deadline`);
    }
    for (const value of ['2026-09-10T14:32:00Z', '2026-09-10T14:32:00.000Z', '2026-09-10T14:32:00.000000Z', '2026-09-10T16:32:00.000+02:00']) {
      assert.equal(isTransferOperation({ ...operation, receiptPollUntil: value }), true, `${JSON.stringify(value)} is a poll deadline`);
    }
  });
});
