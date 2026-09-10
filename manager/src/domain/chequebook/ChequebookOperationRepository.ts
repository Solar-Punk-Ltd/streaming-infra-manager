import type { ChainTransaction } from './chainEvidence.js';
import type { FrozenChequebookTarget } from './FrozenChequebookTarget.js';
import type { ChequebookHistoryQuery, ChequebookHistoryPage, ChequebookOperationEvidence, ChequebookAssertionInput, ChequebookSubmissionResponseEvidence, ChequebookRecoveryObservation, ChequebookAdmissionResult, ChequebookOperation, ChequebookReceiptObservation, ChequebookTransferContext, ChequebookTransferIntent } from '@streaming-infra-manager/common';

export interface NewChequebookOperation extends ChequebookTransferIntent, ChequebookTransferContext {
  readonly id: string;
  /** PostgreSQL admission refuses a missing proof. Optional only for transitional adapters and historical replay. */
  readonly submissionTarget?: FrozenChequebookTarget;
}

export type SubmissionOutcome =
  | { readonly state: 'submitted'; readonly transactionHash: string; readonly failureReason: null }
  | { readonly state: 'unknown'; readonly transactionHash: null; readonly failureReason: 'response_unavailable' | 'invalid_response' }
  | { readonly state: 'rejected'; readonly transactionHash: null; readonly failureReason: 'preflight_failed' };

export interface ChequebookOperationRepository {
  listHistory(query: ChequebookHistoryQuery): Promise<ChequebookHistoryPage>;
  findWithResponses(id: string): Promise<ChequebookOperationEvidence | null>;
  findByRequestId(requestId: string): Promise<ChequebookOperation | null>;
  findById(id: string): Promise<ChequebookOperation | null>;
  /** Atomically deduplicate the request and claim its chain and node. */
  admit(candidate: NewChequebookOperation): Promise<ChequebookAdmissionResult>;
  /** Only the invocation receiving claimed=true may send. Lost acknowledgements never replay. */
  claimDispatch(id: string): Promise<{ claimed: boolean; operation: ChequebookOperation }>;
  /** Direct hash evidence survives concurrent closure without changing an asserted outcome. */
  recordSubmission(id: string, outcome: SubmissionOutcome): Promise<ChequebookOperation>;
  /** Every check advances the observed revision. Stale observations return the current row. */
  recordReceipt(expected: Pick<ChequebookOperation, 'id' | 'revision' | 'transactionHash'>, observation: ChequebookReceiptObservation): Promise<ChequebookOperation>;
  recordRecovery(expected: Pick<ChequebookOperation, 'id' | 'revision'>, observation: ChequebookRecoveryObservation, candidates: readonly ChainTransaction[]): Promise<ChequebookOperation>;
  resolveCandidate(expected: Pick<ChequebookOperation, 'id' | 'revision'>, candidate: ChainTransaction): Promise<ChequebookOperation>;
  assertNoSubmission(expected: Pick<ChequebookOperation, 'id' | 'revision'>, input: ChequebookAssertionInput): Promise<ChequebookOperation>;
  listSubmissionResponses(id: string): Promise<readonly ChequebookSubmissionResponseEvidence[]>;
  /** Rows the poller owes a check: submitted, hash known, unconflicted, budget not spent, last check older than one interval. */
  listAwaitingReceipt(input: { intervalMs: number; limit: number }): Promise<readonly ChequebookOperation[]>;

}
