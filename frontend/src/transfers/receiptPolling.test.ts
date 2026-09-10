/**
 * What the page says while the manager is checking a transfer for the operator.
 *
 * The deadline is the manager's, not the page's: it was written on the record
 * when the transfer became submitted and is never renewed. So the page reads
 * it rather than counting, and once it has passed the page has to say that
 * automatic checking is over instead of leaving a wait with no end.
 *
 * A record can still arrive carrying a deadline the manager would never have
 * written, so the page reads no further ahead than one budget from the moment
 * the record last changed. That ceiling sits on the record rather than on the
 * clock, because a ceiling measured from now moves with every render and would
 * never arrive.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RECEIPT_POLL_BUDGET_MS, RECEIPT_READ_INTERVAL_MS } from '@streaming-infra-manager/common';

import { isPollingReceipt, receiptPollDeadline, receiptPollingSentence } from './receiptPolling';

const at = (iso: string) => Date.parse(iso);
const polled = { state: 'submitted' as const, failureReason: null, receiptPollUntil: '2026-09-10T14:32:00.000Z', updatedAt: '2026-09-10T14:02:00.000Z' };
const localClock = (iso: string) => new Date(at(iso)).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

describe('receiptPollDeadline', () => {
  const whilePolling = at('2026-09-10T14:10:00.000Z');

  it('reads the deadline of a submitted record and nothing else', () => {
    assert.equal(receiptPollDeadline(polled), at('2026-09-10T14:32:00.000Z'));
    assert.equal(receiptPollDeadline({ ...polled, receiptPollUntil: null }), null);
    assert.equal(receiptPollDeadline({ ...polled, state: 'settled' }), null);
    assert.equal(receiptPollDeadline({ ...polled, state: 'unknown' }), null);
    assert.equal(receiptPollDeadline({ ...polled, receiptPollUntil: 'soon' }), null);
    assert.equal(receiptPollDeadline({ ...polled, updatedAt: 'recently' }), null, 'a record whose own timestamp is unreadable leaves no ceiling to read the deadline under');
  });

  it('never reads a deadline further ahead than one budget after the record last changed', () => {
    const distant = { ...polled, receiptPollUntil: '2030-01-01T00:00:00.000Z' };
    assert.equal(receiptPollDeadline(distant), at('2026-09-10T14:32:00.000Z'));
    assert.equal(receiptPollDeadline(polled), at('2026-09-10T14:32:00.000Z'), 'an honest deadline inside the budget is read as it is');
    assert.equal(receiptPollingSentence(distant, whilePolling)?.includes(localClock('2026-09-10T14:32:00.000Z')), true,
      'the page never promises automatic checks further ahead than the manager could still be polling');
  });

  it('ends the checks one budget after the record last changed, however far ahead the field points', () => {
    const stale = { ...polled, receiptPollUntil: '2027-09-10T14:32:00.000Z', updatedAt: '2026-09-10T13:39:00.000Z' };
    assert.equal(receiptPollDeadline(stale), at('2026-09-10T14:09:00.000Z'));
    assert.equal(isPollingReceipt(stale, whilePolling), false);
    assert.equal(receiptPollingSentence(stale, whilePolling),
      `Automatic checks ended at ${localClock('2026-09-10T14:09:00.000Z')} without a final receipt. Use Check to ask the chain again.`);
  });

  it('keeps reading a record that changed a minute ago, and promises no longer than the budget', () => {
    const fresh = { ...polled, receiptPollUntil: '2027-09-10T14:32:00.000Z', updatedAt: '2026-09-10T14:09:00.000Z' };
    assert.equal(isPollingReceipt(fresh, whilePolling), true);
    assert.equal(receiptPollDeadline(fresh), at('2026-09-10T14:39:00.000Z'));
    assert.equal(receiptPollDeadline(fresh)! - whilePolling <= RECEIPT_POLL_BUDGET_MS, true);
    assert.equal(receiptPollingSentence(fresh, whilePolling)?.includes(localClock('2026-09-10T14:39:00.000Z')), true);
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
    assert.equal(sentence, `The manager checks the chain for this transaction's receipt about every 20 seconds until ${localClock('2026-09-10T14:32:00.000Z')}, ` +
      'and leaves longer gaps while the chain endpoint does not answer. This page re-reads the saved record every 10 seconds meanwhile.');
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
