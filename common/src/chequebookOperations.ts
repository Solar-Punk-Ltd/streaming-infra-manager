import { plurToBzzExact } from './chequebook.js';
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
export type ChequebookSubmissionFailure = 'preflight_failed' | 'response_unavailable' | 'invalid_response' | 'hash_conflict';

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
  | { readonly kind: 'could_not_check'; readonly reason: 'rpc_unavailable' | 'identity_mismatch' | 'chain_changed' | 'history_incomplete' | 'attribution_conflict'; readonly history?: ChequebookReceiptHistory }
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
  readonly recoveryObservation: ChequebookRecoveryObservation | null;
  readonly recoveryCheckedAt: string | null;
  readonly assertion: ChequebookAssertion | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChequebookAdmissionResult {
  readonly kind: 'admitted' | 'replayed' | 'busy' | 'conflict';
  readonly operation: ChequebookOperation;
}

export interface ChequebookRecoveryScan {
  readonly headBlockNumber: string;
  readonly headBlockHash: string;
  readonly nextBlockNumber: string;
  readonly nextBlockHash: string;
  readonly complete: boolean;
  readonly candidateHashes: readonly string[];
}

type RecoveryEvidence = { readonly candidateHashes: readonly string[]; readonly scan?: ChequebookRecoveryScan };
export type ChequebookRecoveryObservation = RecoveryEvidence & (
  | { readonly kind: 'searching'; readonly scan: ChequebookRecoveryScan }
  | { readonly kind: 'no_match'; readonly scan: ChequebookRecoveryScan }
  | { readonly kind: 'candidate' | 'ambiguous' }
  | { readonly kind: 'could_not_check'; readonly reason: 'rpc_unavailable' | 'chain_changed' | 'identity_mismatch' | 'evidence_limit'; readonly additionalEvidenceInResponseJournal?: never }
  | { readonly kind: 'could_not_check'; readonly reason: 'attribution_conflict'; readonly additionalEvidenceInResponseJournal?: true }
);

export interface ChequebookAssertionInput {
  /** Supplied by authenticated server context, never by the request body. */
  readonly actor: string;
  readonly amountPlur: string;
  readonly confirmation: string;
}
export interface ChequebookAssertion extends ChequebookAssertionInput {
  readonly assertedAt: string;
}
export interface ChequebookSubmissionResponseEvidence {
  readonly transactionHash: string;
  readonly receivedAt: string;
  readonly ownership: 'owned' | 'conflict';
}

/** Shared exact copy for the typed operator assertion and its server validation. */
export function chequebookAssertionConfirmation(amountPlur: string): string {
  if (!/^[1-9][0-9]{0,29}$/.test(amountPlur)) throw new Error('Invalid chequebook assertion amount.');
  return `I accept that retrying ${plurToBzzExact(BigInt(amountPlur))} BZZ may pay twice.`;
}
