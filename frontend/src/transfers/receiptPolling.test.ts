/**
 * What the page says while the manager is checking a transfer for the operator.
 *
 * The deadline is the manager's, not the page's: it was written on the record
 * when the transfer became submitted and is never renewed. So the page reads
 * it rather than counting, and once it has passed the page has to say that
 * automatic checking is over instead of leaving a wait with no end.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RECEIPT_READ_INTERVAL_MS } from '@streaming-infra-manager/common';

import { isPollingReceipt, receiptPollDeadline, receiptPollingSentence } from './receiptPolling';

const at = (iso: string) => Date.parse(iso);
const polled = { state: 'submitted' as const, failureReason: null, receiptPollUntil: '2026-09-10T14:32:00.000Z' };
const localClock = (iso: string) => new Date(at(iso)).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

describe('receiptPollDeadline', () => {
  it('reads the deadline of a submitted record and nothing else', () => {
    assert.equal(receiptPollDeadline(polled), at('2026-09-10T14:32:00.000Z'));
    assert.equal(receiptPollDeadline({ ...polled, receiptPollUntil: null }), null);
    assert.equal(receiptPollDeadline({ ...polled, state: 'settled' }), null);
    assert.equal(receiptPollDeadline({ ...polled, state: 'unknown' }), null);
    assert.equal(receiptPollDeadline({ ...polled, receiptPollUntil: 'soon' }), null);
  });

  it('reads no deadline off a conflicted record, which the manager excludes from its own checks', () => {
    const conflicted = { ...polled, failureReason: 'hash_conflict' as const };
    assert.equal(receiptPollDeadline(conflicted), null);
    assert.equal(isPollingReceipt(conflicted, at('2026-09-10T14:10:00.000Z')), false);
    assert.equal(receiptPollingSentence(conflicted, at('2026-09-10T14:10:00.000Z')), null);
    assert.equal(receiptPollingSentence(conflicted, at('2026-09-10T15:10:00.000Z')), null);
  });
});

describe('isPollingReceipt', () => {
  it('is true only up to the deadline', () => {
    assert.equal(isPollingReceipt(polled, at('2026-09-10T14:31:59.999Z')), true);
    assert.equal(isPollingReceipt(polled, at('2026-09-10T14:32:00.000Z')), false);
    assert.equal(isPollingReceipt(polled, at('2026-09-10T15:00:00.000Z')), false);
    assert.equal(isPollingReceipt({ ...polled, receiptPollUntil: null }, at('2026-09-10T14:00:00.000Z')), false);
  });
});

describe('receiptPollingSentence', () => {
  it('names the cadence and the deadline in the operator local time while polling lasts', () => {
    const sentence = receiptPollingSentence(polled, at('2026-09-10T14:10:00.000Z'));
    assert.equal(sentence, `The manager checks the chain for this transaction's receipt about every 20 seconds until ${localClock('2026-09-10T14:32:00.000Z')}. ` +
      'This page re-reads the saved record every 10 seconds meanwhile.');
    assert.equal(sentence?.includes(String(RECEIPT_READ_INTERVAL_MS / 1000)), true);
  });

  it('says automatic checking ended once the deadline has passed', () => {
    assert.equal(receiptPollingSentence(polled, at('2026-09-10T14:32:00.001Z')),
      `Automatic checks ended at ${localClock('2026-09-10T14:32:00.000Z')} without a final receipt. Use Check to ask the chain again.`);
  });

  it('says nothing about a record the manager never polled or has already finished', () => {
    assert.equal(receiptPollingSentence({ ...polled, receiptPollUntil: null }, at('2026-09-10T14:10:00.000Z')), null);
    assert.equal(receiptPollingSentence({ ...polled, state: 'settled' }, at('2026-09-10T15:10:00.000Z')), null);
    assert.equal(receiptPollingSentence({ ...polled, state: 'reverted' }, at('2026-09-10T15:10:00.000Z')), null);
  });
});
