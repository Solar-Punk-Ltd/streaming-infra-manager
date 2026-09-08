import type { ChequebookHistoryPage, ChequebookOperation, ChequebookOperationDetail } from '@streaming-infra-manager/common';
import { apiFetch, SessionEndedError } from '../http';
import { isCompleteTransferDetail, isTransferOperation } from './transferEvidence';

export type TransferDetailKey = { readonly kind: 'operation' | 'request'; readonly id: string };
export class TransferHistoryError extends Error {
  constructor(readonly reason: 'unavailable' | 'invalid_response' | 'identity_conflict') {
    super('Saved transfer information could not be verified.');
    this.name = 'TransferHistoryError';
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const dated = (value: unknown) => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
function operation(value: unknown): value is ChequebookOperation {
  return isTransferOperation(value) && dated(value.createdAt) && dated(value.updatedAt) &&
    [value.dispatchStartedAt, value.receiptCheckedAt, value.recoveryCheckedAt].every(item => item === null || dated(item)) &&
    typeof value.nonceLowerBound === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value.nonceLowerBound) && typeof value.nonceQueryTag === 'string';
}
async function read(path: string, signal: AbortSignal): Promise<Response> {
  try { return await apiFetch(path, { signal, cache: 'no-store' }); }
  catch (error) {
    if (error instanceof SessionEndedError || signal.aborted) throw error;
    throw new TransferHistoryError('unavailable');
  }
}
async function body(response: Response): Promise<unknown> {
  if (!response.ok) throw new TransferHistoryError('unavailable');
  try { return await response.json(); }
  catch { throw new TransferHistoryError('invalid_response'); }
}
export async function readTransferHistory(cursor: string | undefined, signal: AbortSignal): Promise<ChequebookHistoryPage> {
  if (cursor !== undefined && (!cursor || cursor.length > 512)) throw new TransferHistoryError('invalid_response');
  const query = new URLSearchParams({ limit: '25' });
  if (cursor) query.set('cursor', cursor);
  const value = await body(await read(`/chequebook/operations?${query}`, signal));
  if (!value || typeof value !== 'object') throw new TransferHistoryError('invalid_response');
  const page = value as ChequebookHistoryPage;
  if (!Array.isArray(page.operations) || page.operations.length > 25 || !page.operations.every(operation) ||
      new Set(page.operations.map(item => item.id)).size !== page.operations.length ||
      !(page.nextCursor === null || (typeof page.nextCursor === 'string' && page.nextCursor.length > 0 && page.nextCursor.length <= 512 && page.nextCursor !== cursor))) {
    throw new TransferHistoryError('invalid_response');
  }
  return page;
}
export async function readTransferDetail(key: TransferDetailKey, signal: AbortSignal): Promise<ChequebookOperationDetail | null> {
  if (!uuid.test(key.id)) throw new TransferHistoryError('invalid_response');
  const path = key.kind === 'request' ? `/chequebook/operations/by-request/${key.id}` : `/chequebook/operations/${key.id}`;
  const response = await read(path, signal);
  if (response.status === 404) return null;
  const value = await body(response);
  if (!isCompleteTransferDetail(value) || !operation(value.operation)) throw new TransferHistoryError('invalid_response');
  if ((key.kind === 'request' ? value.operation.requestId : value.operation.id) !== key.id) throw new TransferHistoryError('identity_conflict');
  return value;
}

/** These fields were frozen before dispatch. A refreshed status cannot replace them. */
export function transferIdentity(operation: ChequebookOperation): string {
  return JSON.stringify([operation.id, operation.requestId, operation.requestedBy, operation.profileName, operation.profileInstanceId,
    operation.direction, operation.amountPlur, operation.chainId, operation.nodeAddress, operation.chequebookAddress, operation.tokenAddress,
    operation.startBlockNumber, operation.startBlockHash, operation.nonceLowerBound, operation.nonceQueryTag, operation.createdAt]);
}
