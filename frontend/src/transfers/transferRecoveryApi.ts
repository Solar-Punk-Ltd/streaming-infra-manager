import {
  CHEQUEBOOK_OPERATION_CHANGED_MESSAGE,
  CHEQUEBOOK_RECOVERY_ACCOUNT_CHANGED_MESSAGE,
  isChequebookRevision,
  type ChequebookAssertRequest,
  type ChequebookOperationDetail,
  type ChequebookRecoveryRequest,
  type ChequebookResolveRequest,
} from '@streaming-infra-manager/common';
import { apiFetch, SessionEndedError } from '../http';
import { isCompleteTransferDetail } from './transferEvidence';
import { transferIdentity } from './transferHistoryApi';

export type TransferRecoveryAction =
  | { readonly kind: 'check' }
  | { readonly kind: 'resolve'; readonly transactionHash: string }
  | ({ readonly kind: 'assert' } & Omit<ChequebookAssertRequest, 'expectedAccountId'>);

type RecoveryFailure = 'invalid_input' | 'account_changed' | 'operation_changed' | 'recovery_required' | 'not_found' |
  'unavailable' | 'invalid_response' | 'identity_conflict';
const messages: Record<RecoveryFailure, string> = {
  invalid_input: 'This action could not be accepted. Review its inputs and saved evidence.',
  account_changed: CHEQUEBOOK_RECOVERY_ACCOUNT_CHANGED_MESSAGE,
  operation_changed: CHEQUEBOOK_OPERATION_CHANGED_MESSAGE,
  recovery_required: 'This action is not available for the current evidence. Refresh the saved transfer.',
  not_found: 'No manager record was returned for this operation. Its outcome remains unverified.',
  unavailable: 'The action response was not received. Refresh saved evidence before reviewing another action.',
  invalid_response: 'The action response could not be verified. Refresh saved evidence before reviewing another action.',
  identity_conflict: 'Returned evidence does not match this saved transfer. Its outcome remains unresolved.',
};
export class TransferRecoveryError extends Error {
  constructor(readonly reason: RecoveryFailure, readonly outcome: 'refused' | 'unknown') {
    super(messages[reason]);
    this.name = 'TransferRecoveryError';
  }
}

function requestBody(reviewed: ChequebookOperationDetail, expectedAccountId: number, action: TransferRecoveryAction):
  ChequebookRecoveryRequest | ChequebookResolveRequest | ChequebookAssertRequest {
  if (!isCompleteTransferDetail(reviewed) || !isChequebookRevision(reviewed.operation.revision) ||
      !Number.isSafeInteger(expectedAccountId) || expectedAccountId < 1) throw new TransferRecoveryError('invalid_input', 'refused');
  switch (action.kind) {
    case 'check': return { expectedAccountId };
    case 'resolve':
      if (!/^0x[0-9a-f]{64}$/.test(action.transactionHash)) throw new TransferRecoveryError('invalid_input', 'refused');
      return { expectedAccountId, transactionHash: action.transactionHash };
    case 'assert':
      if (!isChequebookRevision(action.expectedRevision) || action.expectedRevision !== reviewed.operation.revision ||
          action.amountPlur !== reviewed.operation.amountPlur || action.confirmation !== reviewed.assertionConfirmation) {
        throw new TransferRecoveryError('invalid_input', 'refused');
      }
      return { expectedAccountId, expectedRevision: action.expectedRevision, amountPlur: action.amountPlur, confirmation: action.confirmation };
    default: throw new TransferRecoveryError('invalid_input', 'refused');
  }
}

async function refusal(response: Response): Promise<TransferRecoveryError> {
  let code: unknown;
  try { code = (await response.json())?.error; }
  catch { return new TransferRecoveryError('unavailable', 'unknown'); }
  if (response.status === 409) {
    if (code === 'account_changed' || code === 'operation_changed') return new TransferRecoveryError(code, 'refused');
    if (code === 'chequebook_recovery_required') return new TransferRecoveryError('recovery_required', 'refused');
  }
  if (response.status === 404 && code === 'chequebook_operation_not_found') return new TransferRecoveryError('not_found', 'refused');
  if (response.status === 400 && code === 'validation_error') return new TransferRecoveryError('invalid_input', 'refused');
  return new TransferRecoveryError('unavailable', 'unknown');
}

/** One explicit observation or assertion request. Response loss never causes a retry. */
export async function runTransferRecovery(reviewed: ChequebookOperationDetail, expectedAccountId: number,
  action: TransferRecoveryAction, signal: AbortSignal): Promise<ChequebookOperationDetail> {
  const body = requestBody(reviewed, expectedAccountId, action);
  let response: Response;
  try {
    response = await apiFetch(`/chequebook/operations/${reviewed.operation.id}/${action.kind}`, { method: 'POST', body, signal, cache: 'no-store' });
  } catch (error) {
    if (error instanceof SessionEndedError || signal.aborted) throw error;
    throw new TransferRecoveryError('unavailable', 'unknown');
  }
  if (!response.ok) throw await refusal(response);
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new TransferRecoveryError('invalid_response', 'unknown'); }
  if (!isCompleteTransferDetail(value) || !isChequebookRevision(value.operation.revision) ||
      BigInt(value.operation.revision) < BigInt(reviewed.operation.revision)) throw new TransferRecoveryError('invalid_response', 'unknown');
  if (transferIdentity(value.operation) !== transferIdentity(reviewed.operation)) throw new TransferRecoveryError('identity_conflict', 'unknown');
  return value;
}
