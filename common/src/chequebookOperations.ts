import type { TransferDirection } from './chequebook.js';

export interface ChequebookTransferIntent {
  readonly requestId: string;
  readonly profileName: string;
  readonly requestedBy: string;
  readonly direction: TransferDirection;
  readonly amountPlur: string;
}

export interface ChequebookTransferContext {
  readonly chainId: number;
  readonly nodeAddress: string;
  readonly chequebookAddress: string;
  readonly tokenAddress: string;
  readonly startBlockNumber: string;
  readonly startBlockHash: string;
  /** An observed lower bound, never a nonce reserved for this transfer. */
  readonly nonceLowerBound: string;
  readonly nonceQueryTag: string;
}

export type ChequebookOperationState = 'submitting' | 'submitted' | 'unknown' | 'settled' | 'reverted' | 'asserted' | 'rejected';
export type ChequebookSubmissionFailure = 'preflight_failed' | 'response_unavailable' | 'invalid_response';

export interface ChequebookOperation extends ChequebookTransferIntent, ChequebookTransferContext {
  readonly id: string;
  readonly state: ChequebookOperationState;
  readonly transactionHash: string | null;
  readonly failureReason: ChequebookSubmissionFailure | null;
  readonly dispatchStartedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChequebookAdmissionResult {
  readonly kind: 'admitted' | 'replayed' | 'busy' | 'conflict';
  readonly operation: ChequebookOperation;
}
