import { chequebookAssertionConfirmation, type ChequebookOperation, type ChequebookOperationDetail, type ChequebookOperationEvidence } from '@streaming-infra-manager/common';

const HASH = /^0x[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const integer = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value);

export function isTransferOperation(value: unknown): value is ChequebookOperation {
  if (!value || typeof value !== 'object') return false;
  const operation = value as ChequebookOperation;
  if (typeof operation.id !== 'string' || !UUID.test(operation.id) || typeof operation.requestId !== 'string' || !UUID.test(operation.requestId) ||
      typeof operation.amountPlur !== 'string' || !/^[1-9][0-9]{0,29}$/.test(operation.amountPlur) ||
      !['submitting', 'submitted', 'unknown', 'settled', 'reverted', 'asserted', 'rejected'].includes(operation.state) ||
      !Number.isSafeInteger(operation.chainId) || operation.chainId < 1 ||
      ![operation.nodeAddress, operation.chequebookAddress, operation.tokenAddress].every(value => typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value)) ||
      typeof operation.profileName !== 'string' || typeof operation.requestedBy !== 'string' ||
      (operation.profileInstanceId !== null && (typeof operation.profileInstanceId !== 'string' || !UUID.test(operation.profileInstanceId))) ||
      !['deposit', 'withdraw'].includes(operation.direction) || !integer(operation.revision) || !integer(operation.startBlockNumber) || !hash(operation.startBlockHash) ||
      (operation.transactionHash !== null && !hash(operation.transactionHash)) ||
      ![null, 'preflight_failed', 'response_unavailable', 'invalid_response', 'hash_conflict'].includes(operation.failureReason) ||
      operation.receiptObservation === undefined || operation.recoveryObservation === undefined || operation.assertion === undefined || operation.dispatchStartedAt === undefined) return false;
  return true;
}

/** A history summary omits response evidence and cannot authorize a new intent. */
export function isCompleteTransferDetail(value: unknown): value is ChequebookOperationDetail {
  if (!value || typeof value !== 'object') return false;
  const detail = value as ChequebookOperationDetail;
  const operation = detail.operation;
  if (!isTransferOperation(operation) || !Array.isArray(detail.responseEvidence)) return false;
  return detail.assertionConfirmation === chequebookAssertionConfirmation(operation.amountPlur) && detail.responseEvidence.every(evidence =>
    evidence && typeof evidence.transactionHash === 'string' && HASH.test(evidence.transactionHash) &&
    typeof evidence.receivedAt === 'string' && Number.isFinite(Date.parse(evidence.receivedAt)) && ['owned', 'conflict'].includes(evidence.ownership));
}

export function hasAttributionConflict(detail: ChequebookOperationEvidence): boolean {
  const operation = detail.operation;
  const receipt = operation.receiptObservation;
  const recovery = operation.recoveryObservation;
  const hashes = new Set([operation.transactionHash, ...detail.responseEvidence.map(evidence => evidence.transactionHash)].filter(Boolean));
  return operation.failureReason === 'hash_conflict' || hashes.size > 1 || detail.responseEvidence.some(evidence => evidence.ownership === 'conflict') ||
    (operation.state === 'rejected' && (operation.dispatchStartedAt !== null || operation.transactionHash !== null || detail.responseEvidence.length > 0)) ||
    (receipt?.kind === 'could_not_check' && receipt.reason === 'attribution_conflict') || recovery?.kind === 'ambiguous' ||
    (recovery?.kind === 'could_not_check' && recovery.reason === 'attribution_conflict');
}

export function permitsNewTransfer(detail: ChequebookOperationDetail): boolean {
  if (!isCompleteTransferDetail(detail) || hasAttributionConflict(detail)) return false;
  const operation = detail.operation;
  const receipt = operation.receiptObservation;
  if (operation.state === 'settled' || operation.state === 'reverted') {
    return hash(operation.transactionHash) && receipt?.kind === operation.state && integer(receipt.receiptBlockNumber) &&
      integer(receipt.finalizedBlockNumber) && hash(receipt.receiptBlockHash) && hash(receipt.finalizedBlockHash) &&
      BigInt(receipt.receiptBlockNumber) >= BigInt(operation.startBlockNumber) && BigInt(receipt.finalizedBlockNumber) >= BigInt(receipt.receiptBlockNumber);
  }
  if (operation.state === 'rejected') return operation.failureReason === 'preflight_failed' && operation.dispatchStartedAt === null && operation.transactionHash === null && detail.responseEvidence.length === 0;
  if (operation.state === 'asserted') return hasRecordedTransferAssertion(detail);
  return false;
}

/** Audit evidence remains visible even when a later conflict prevents another transfer. */
export function hasRecordedTransferAssertion(detail: ChequebookOperationDetail): boolean {
  const assertion = detail.operation.assertion;
  return assertion !== null && typeof assertion.actor === 'string' && assertion.actor.trim().length > 0 &&
    assertion.amountPlur === detail.operation.amountPlur && assertion.confirmation === detail.assertionConfirmation &&
    typeof assertion.assertedAt === 'string' && Number.isFinite(Date.parse(assertion.assertedAt));
}

export function transferHeadline(detail: ChequebookOperationEvidence): string {
  if (!detail?.operation || !Array.isArray(detail.responseEvidence)) return 'Recorded outcome needs verification';
  if (hasAttributionConflict(detail)) return 'Transaction evidence needs review';
  let supported = false;
  try { supported = permitsNewTransfer({ ...detail, assertionConfirmation: chequebookAssertionConfirmation(detail.operation.amountPlur) }); }
  catch { /* Malformed amounts cannot justify a terminal headline. */ }
  switch (detail.operation.state) {
    case 'asserted': return supported ? 'Operator assertion recorded' : 'Recorded outcome needs verification';
    case 'rejected': return supported ? 'Transfer refused before submission' : 'Recorded outcome needs verification';
    case 'settled': return supported ? 'Transfer verified on chain' : 'Recorded outcome needs verification';
    case 'reverted': return supported ? 'Transaction reverted' : 'Recorded outcome needs verification';
    case 'submitted': return 'Waiting for transaction confirmation';
    case 'submitting': return 'Submission in progress';
    case 'unknown': return 'Submission outcome unknown';
    default: return 'Recorded outcome needs verification';
  }
}
