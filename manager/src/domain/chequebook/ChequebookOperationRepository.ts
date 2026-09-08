import type { ChequebookAdmissionResult, ChequebookOperation, ChequebookTransferContext, ChequebookTransferIntent } from '@streaming-infra-manager/common';

export interface NewChequebookOperation extends ChequebookTransferIntent, ChequebookTransferContext {
  readonly id: string;
}

export type SubmissionOutcome =
  | { readonly state: 'submitted'; readonly transactionHash: string; readonly failureReason: null }
  | { readonly state: 'unknown'; readonly transactionHash: null; readonly failureReason: 'response_unavailable' | 'invalid_response' }
  | { readonly state: 'rejected'; readonly transactionHash: null; readonly failureReason: 'preflight_failed' };

export interface ChequebookOperationRepository {
  findByRequestId(requestId: string): Promise<ChequebookOperation | null>;
  findById(id: string): Promise<ChequebookOperation | null>;
  /** Atomically deduplicate the request and claim its chain and node. */
  admit(candidate: NewChequebookOperation): Promise<ChequebookAdmissionResult>;
  /** Only the invocation receiving claimed=true may send. Lost acknowledgements never replay. */
  claimDispatch(id: string): Promise<{ claimed: boolean; operation: ChequebookOperation }>;
  /** Change only a still-submitting row. A concurrent resolution wins. */
  recordSubmission(id: string, outcome: SubmissionOutcome): Promise<ChequebookOperation>;
}
