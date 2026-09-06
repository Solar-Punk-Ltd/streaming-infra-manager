import type {
  BeeTransaction,
  ChequebookSummary,
} from '@streaming-infra-manager/common';

import { getJson, sendJson } from '../http';

export function fetchChequebook(name: string): Promise<ChequebookSummary> {
  return getJson<ChequebookSummary>(
    `/profiles/${encodeURIComponent(name)}/chequebook`,
  );
}

/**
 * Both moves take PLUR, bee's integer unit, so the caller converts what the
 * operator typed with `bzzToPlur` and the manager never has to guess which
 * unit a number is in.
 */
export function depositChequebook(
  name: string,
  amountPlur: bigint,
): Promise<BeeTransaction> {
  return sendJson<BeeTransaction>(
    'POST',
    `/profiles/${encodeURIComponent(name)}/chequebook/deposit`,
    { amount: amountPlur.toString() },
  );
}

export function withdrawChequebook(
  name: string,
  amountPlur: bigint,
): Promise<BeeTransaction> {
  return sendJson<BeeTransaction>(
    'POST',
    `/profiles/${encodeURIComponent(name)}/chequebook/withdraw`,
    { amount: amountPlur.toString() },
  );
}
