/**
 * The receipt polling numbers, which the manager and the page both quote.
 *
 * A submitted transfer gets one polling budget when it enters that state. The
 * manager checks the chain while the budget lasts, and the page re-reads the
 * saved record meanwhile. Both surfaces have to say the same seconds, so the
 * numbers live here and nothing restates them.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RECEIPT_POLL_BUDGET_MS,
  RECEIPT_POLL_INTERVAL_MS,
  RECEIPT_READ_INTERVAL_MS,
  type ChequebookOperation,
} from './chequebookOperations.js';

describe('receipt polling constants', () => {
  it('states one budget, one chain cadence and one page cadence in whole seconds', () => {
    assert.equal(RECEIPT_POLL_BUDGET_MS, 1_800_000);
    assert.equal(RECEIPT_POLL_INTERVAL_MS, 20_000);
    assert.equal(RECEIPT_READ_INTERVAL_MS, 10_000);
    for (const value of [RECEIPT_POLL_BUDGET_MS, RECEIPT_POLL_INTERVAL_MS, RECEIPT_READ_INTERVAL_MS]) {
      assert.equal(Number.isSafeInteger(value) && value > 0 && value % 1000 === 0, true);
    }
  });

  it('spends the budget over many chain checks and re-reads more often than it checks', () => {
    assert.equal(RECEIPT_POLL_BUDGET_MS / RECEIPT_POLL_INTERVAL_MS >= 10, true);
    assert.equal(RECEIPT_READ_INTERVAL_MS < RECEIPT_POLL_INTERVAL_MS, true);
  });

  it('carries the poll deadline on the operation record beside the last check time', () => {
    const operation = {
      receiptCheckedAt: '2026-09-10T14:02:00.000Z',
      receiptPollUntil: '2026-09-10T14:32:00.000Z',
    } satisfies Pick<ChequebookOperation, 'receiptCheckedAt' | 'receiptPollUntil'>;
    assert.equal(operation.receiptPollUntil, '2026-09-10T14:32:00.000Z');
    const unpolled = { receiptCheckedAt: null, receiptPollUntil: null } satisfies Pick<ChequebookOperation, 'receiptCheckedAt' | 'receiptPollUntil'>;
    assert.equal(unpolled.receiptPollUntil, null);
  });
});
