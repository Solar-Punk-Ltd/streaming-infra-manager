import { RECEIPT_POLL_BUDGET_MS } from '@streaming-infra-manager/common';

/** One budget per submitted operation, opened once and never renewed, the way the journal does it. */
export function openReceiptPollBudget(operation) {
  if (operation.state === 'submitted' && operation.receiptPollUntil === null) {
    operation.receiptPollUntil = new Date(Date.now() + RECEIPT_POLL_BUDGET_MS).toISOString();
  }
}
