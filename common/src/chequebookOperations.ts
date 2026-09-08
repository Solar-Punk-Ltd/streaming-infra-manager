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

export interface ChequebookReceiptHistory {
  readonly transactionHash: string;
  readonly receiptBlockNumber: string;
  readonly receiptBlockHash: string;
  readonly receiptStatus: 'success' | 'reverted';
  readonly finalizedBlockNumber: string;
  readonly finalizedBlockHash: string;
  readonly cursorBlockNumber: string;
  readonly cursorBlockHash: string;
}

export type ChequebookReceiptObservation =
  | { readonly kind: 'pending'; readonly reason: 'awaiting_transaction' | 'awaiting_receipt' | 'awaiting_finality' }
  | { readonly kind: 'could_not_check'; readonly reason: 'rpc_unavailable' | 'identity_mismatch' | 'chain_changed' | 'history_incomplete'; readonly history?: ChequebookReceiptHistory }
  | {
    readonly kind: 'settled' | 'reverted';
    readonly receiptBlockNumber: string;
    readonly receiptBlockHash: string;
    readonly finalizedBlockNumber: string;
    readonly finalizedBlockHash: string;
  };

export interface ChequebookOperation extends ChequebookTransferIntent, ChequebookTransferContext {
  readonly id: string;
  readonly state: ChequebookOperationState;
  readonly transactionHash: string | null;
  readonly failureReason: ChequebookSubmissionFailure | null;
  readonly dispatchStartedAt: string | null;
  readonly revision: string;
  readonly receiptObservation: ChequebookReceiptObservation | null;
  readonly receiptCheckedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChequebookAdmissionResult {
  readonly kind: 'admitted' | 'replayed' | 'busy' | 'conflict';
  readonly operation: ChequebookOperation;
}
