import { RECEIPT_POLL_INTERVAL_MS, RECEIPT_READ_INTERVAL_MS, type ChequebookOperation } from '@streaming-infra-manager/common';

export type PolledTransfer = Pick<ChequebookOperation, 'state' | 'receiptPollUntil'>;

/** When the manager stops checking this transfer on its own, or null when it never was. */
export function receiptPollDeadline(operation: PolledTransfer): number | null {
  if (operation.state !== 'submitted' || operation.receiptPollUntil === null) return null;
  const deadline = Date.parse(operation.receiptPollUntil);
  return Number.isFinite(deadline) ? deadline : null;
}

export function isPollingReceipt(operation: PolledTransfer, now = Date.now()): boolean {
  const deadline = receiptPollDeadline(operation);
  return deadline !== null && deadline > now;
}

const wholeSeconds = (milliseconds: number) => String(milliseconds / 1000);
const localClockTime = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export function receiptPollingSentence(operation: PolledTransfer, now = Date.now()): string | null {
  const deadline = receiptPollDeadline(operation);
  if (deadline === null) return null;
  if (deadline <= now) return `Automatic checks ended at ${localClockTime(deadline)} without a final receipt. Use Check to ask the chain again.`;
  return `The manager checks the chain for this transaction's receipt about every ${wholeSeconds(RECEIPT_POLL_INTERVAL_MS)} seconds until ${localClockTime(deadline)}. ` +
    `This page re-reads the saved record every ${wholeSeconds(RECEIPT_READ_INTERVAL_MS)} seconds meanwhile.`;
}
