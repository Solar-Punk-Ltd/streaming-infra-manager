import { isChequebookRevision, type ChequebookOperationDetail } from '@streaming-infra-manager/common';
import { hasAttributionConflict, isCompleteTransferDetail } from './transferEvidence';

export function canCheckTransfer(detail: ChequebookOperationDetail): boolean {
  return isCompleteTransferDetail(detail) && detail.operation.failureReason !== 'hash_conflict' &&
    ['submitting', 'submitted', 'unknown'].includes(detail.operation.state);
}

/** A completed bounded pass supports only the duplicate-risk assertion, never a claim of permanent absence. */
export function canAssertTransfer(detail: ChequebookOperationDetail): boolean {
  if (!canCheckTransfer(detail) || hasAttributionConflict(detail)) return false;
  const operation = detail.operation;
  const observation = operation.recoveryObservation;
  const scan = observation?.scan;
  return ['submitting', 'unknown'].includes(operation.state) && isChequebookRevision(operation.revision) &&
    operation.transactionHash === null && detail.responseEvidence.length === 0 && observation?.kind === 'no_match' &&
    Array.isArray(observation.candidateHashes) && observation.candidateHashes.length === 0 && scan?.complete === true &&
    Array.isArray(scan.candidateHashes) && scan.candidateHashes.length === 0 && scan.nextBlockNumber === operation.startBlockNumber &&
    scan.nextBlockHash === operation.startBlockHash && typeof scan.headBlockNumber === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(scan.headBlockNumber) &&
    BigInt(scan.headBlockNumber) >= BigInt(operation.startBlockNumber) && /^0x[0-9a-f]{64}$/.test(scan.headBlockHash) &&
    typeof operation.recoveryCheckedAt === 'string' && Number.isFinite(Date.parse(operation.recoveryCheckedAt));
}
