import { plurToBzzExact } from './chequebook.js';
import type { TransferDirection } from './chequebook.js';

export const CHEQUEBOOK_ACCOUNT_CHANGED_MESSAGE = 'The signed-in account changed. Sign in with the account that confirmed this transfer.';
export const CHEQUEBOOK_RECOVERY_ACCOUNT_CHANGED_MESSAGE = 'The signed-in account changed. Review this action again with your current account.';
export const CHEQUEBOOK_OPERATION_CHANGED_MESSAGE = 'The saved transfer changed. Refresh its evidence and review the action again.';

/** How long the manager keeps checking one submitted transfer. Set once when it enters that state, never renewed. */
export const RECEIPT_POLL_BUDGET_MS = 30 * 60_000;
/** How often the manager asks the chain for a receipt while the budget lasts. */
export const RECEIPT_POLL_INTERVAL_MS = 20_000;
/** How often a page showing a polled transfer re-reads the saved record. */
export const RECEIPT_READ_INTERVAL_MS = 10_000;

/** Journal revisions are nonnegative PostgreSQL bigint values, kept as exact decimal strings. */
export function isChequebookRevision(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
}

export interface ChequebookRecoveryRequest {
  readonly expectedAccountId: number;
}
export interface ChequebookResolveRequest extends ChequebookRecoveryRequest {
  readonly transactionHash: string;
}
export interface ChequebookAssertRequest extends ChequebookRecoveryRequest {
  readonly expectedRevision: string;
  readonly amountPlur: string;
  readonly confirmation: string;
}

export interface ChequebookSubmitRequest {
  readonly requestId: string;
  readonly profileInstanceId: string;
  /** A concurrency precondition. The authenticated session still determines the actor. */
  readonly expectedAccountId: number;
  readonly amount: string;
}

export interface ChequebookTransferIntent {
  readonly requestId: string;
  readonly profileName: string;
  readonly profileInstanceId: string;
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

export interface ChequebookOperation extends Omit<ChequebookTransferIntent, 'profileInstanceId'>, ChequebookTransferContext {
  /** NULL on historical records whose profile lifetime was not captured. */
  readonly profileInstanceId: string | null;
  readonly id: string;
  readonly state: ChequebookOperationState;
  readonly transactionHash: string | null;
  readonly failureReason: ChequebookSubmissionFailure | null;
  readonly dispatchStartedAt: string | null;
  readonly revision: string;
  readonly receiptObservation: ChequebookReceiptObservation | null;
  readonly receiptCheckedAt: string | null;
  /** When automatic receipt polling stops. NULL on every row the manager never polled. */
  readonly receiptPollUntil: string | null;
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

export interface ChequebookHistoryQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly profileName?: string;
}
export interface ChequebookHistoryPage {
  readonly operations: readonly ChequebookOperation[];
  readonly nextCursor: string | null;
}
export interface ChequebookOperationEvidence {
  readonly operation: ChequebookOperation;
  /** Complete direct-response evidence, including hashes beyond the bounded candidate list. */
  readonly responseEvidence: readonly ChequebookSubmissionResponseEvidence[];
}
export interface ChequebookOperationDetail extends ChequebookOperationEvidence {
  readonly assertionConfirmation: string;
}
export interface ChequebookAdmissionDetail extends ChequebookOperationDetail {
  readonly kind: ChequebookAdmissionResult['kind'];
}
