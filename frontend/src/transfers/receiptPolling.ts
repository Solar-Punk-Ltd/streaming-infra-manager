import { RECEIPT_POLL_BUDGET_MS, RECEIPT_POLL_INTERVAL_MS, RECEIPT_READ_INTERVAL_MS, type ChequebookOperation } from '@streaming-infra-manager/common';

export type PolledTransfer = Pick<ChequebookOperation, 'state' | 'failureReason' | 'receiptPollUntil'>;

/**
 * When the manager stops checking this transfer on its own, or null when it never was.
 *
 * Capped at one whole budget from now, because that is the furthest ahead the
 * manager could still be polling and a wrong field must not keep a tab reading.
 */
export function receiptPollDeadline(operation: PolledTransfer, now = Date.now()): number | null {
  if (operation.state !== 'submitted' || operation.failureReason === 'hash_conflict' || operation.receiptPollUntil === null) return null;
  const deadline = Date.parse(operation.receiptPollUntil);
  return Number.isFinite(deadline) ? Math.min(deadline, now + RECEIPT_POLL_BUDGET_MS) : null;
}

export function isPollingReceipt(operation: PolledTransfer, now = Date.now()): boolean {
  const deadline = receiptPollDeadline(operation, now);
  return deadline !== null && deadline > now;
}

const wholeSeconds = (milliseconds: number) => String(milliseconds / 1000);
const localClockTime = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export function receiptPollingSentence(operation: PolledTransfer, now = Date.now()): string | null {
  const deadline = receiptPollDeadline(operation, now);
  if (deadline === null) return null;
  if (deadline <= now) return `Automatic checks ended at ${localClockTime(deadline)} without a final receipt. Use Check to ask the chain again.`;
  return `The manager checks the chain for this transaction's receipt about every ${wholeSeconds(RECEIPT_POLL_INTERVAL_MS)} seconds until ${localClockTime(deadline)}. ` +
    `This page re-reads the saved record every ${wholeSeconds(RECEIPT_READ_INTERVAL_MS)} seconds meanwhile.`;
}
