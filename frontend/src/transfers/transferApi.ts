import type { ChequebookAdmissionDetail, ChequebookOperationDetail, ChequebookSubmitRequest } from '@streaming-infra-manager/common';
import { apiFetch, SessionEndedError, type ApiRequest } from '../http';
import type { TransferControllerApi, TransferProfileIdentity } from './TransferController';
import { TransferApiError } from './TransferApiError';
import { isCompleteTransferDetail } from './transferEvidence';
import type { StoredTransferIntent } from './transferIntentStore';

const operationsPath = '/chequebook/operations';

async function request(path: string, options: ApiRequest): Promise<Response> {
  try { return await apiFetch(path, options); }
  catch (error) {
    if (error instanceof SessionEndedError || options.signal?.aborted) throw error;
    throw new TransferApiError('unavailable');
  }
}

async function body(response: Response): Promise<unknown> {
  try { return await response.json(); }
  catch { throw new TransferApiError('invalid_response'); }
}

async function refused(response: Response): Promise<never> {
  let value: unknown;
  try { value = await response.json(); } catch { /* Error bodies are optional and never copied into product messages. */ }
  const code = value && typeof value === 'object' && 'error' in value ? value.error : null;
  if (response.status === 409 && code === 'account_changed') throw new TransferApiError('account_changed');
  if (response.status === 409 && code === 'chequebook_profile_changed') throw new TransferApiError('target_changed');
  throw new TransferApiError('unavailable');
}

export const transferApi: TransferControllerApi = {
  async lookup(requestId: string, signal: AbortSignal): Promise<ChequebookOperationDetail | null> {
    const response = await request(`${operationsPath}/by-request/${encodeURIComponent(requestId)}`, { signal, cache: 'no-store' });
    if (response.status === 404) return null;
    if (!response.ok) return refused(response);
    const value = await body(response);
    if (!isCompleteTransferDetail(value)) throw new TransferApiError('invalid_response');
    return value;
  },
  async profile(name: string, signal: AbortSignal): Promise<TransferProfileIdentity | null> {
    const response = await request(`/profiles/${encodeURIComponent(name)}`, { signal, cache: 'no-store' });
    if (response.status === 404) return null;
    if (!response.ok) return refused(response);
    const value = await body(response);
    if (!value || typeof value !== 'object' || !('name' in value) || typeof value.name !== 'string' ||
        !('instance_id' in value) || typeof value.instance_id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.instance_id)) throw new TransferApiError('invalid_response');
    return { name: value.name, instanceId: value.instance_id };
  },
  async submit(intent: StoredTransferIntent, signal: AbortSignal): Promise<ChequebookAdmissionDetail> {
    const input: ChequebookSubmitRequest = { requestId: intent.requestId, profileInstanceId: intent.profileInstanceId,
      expectedAccountId: intent.accountId, amount: intent.amountPlur };
    const response = await request(`/profiles/${encodeURIComponent(intent.profileName)}/chequebook/${intent.direction}`,
      { method: 'POST', body: input, signal });
    if (response.status !== 202 && response.status !== 409) return refused(response);
    const value = await body(response);
    if (response.status === 409 && value && typeof value === 'object' && 'error' in value) {
      if (value.error === 'account_changed') throw new TransferApiError('account_changed');
      if (value.error === 'chequebook_profile_changed') throw new TransferApiError('target_changed');
      throw new TransferApiError('unavailable');
    }
    if (!isCompleteTransferDetail(value) || !('kind' in value) ||
        !(response.status === 409 ? ['busy', 'conflict'] : ['admitted', 'replayed']).includes(value.kind as string)) throw new TransferApiError('invalid_response');
    return value as ChequebookAdmissionDetail;
  },
};
