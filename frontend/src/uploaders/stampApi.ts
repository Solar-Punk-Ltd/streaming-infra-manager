import type {
  BeeNodeObservation,
  BeeStampTransaction,
  DiluteStampRequest,
  TopUpStampRequest,
} from '@streaming-infra-manager/common';
import type { Profile } from '../types';
import { getJson, sendJson } from '../http';

export interface BeeAddress {
  ethereum: string;
  overlay?: string;
}

export interface BeeWallet {
  bzzBalance: string;
  nativeTokenBalance: string;
}

export interface BeeStamp {
  batchID: string;
  utilization: number;
  usable: boolean;
  label?: string;
  depth: number;
  amount: string;
  bucketDepth: number;
  blockNumber: number;
  immutableFlag: boolean;
  exists: boolean;
  batchTTL: number;
}

export interface BuyStampInput {
  amount: string;
  depth: number;
  label?: string;
  immutable?: boolean;
}

export interface BeeChainState {
  chainTip: number;
  block: number;
  totalAmount: string;
  currentPrice: string;
}

export function fetchStampAddress(name: string, signal?: AbortSignal): Promise<BeeAddress> {
  return getJson<BeeAddress>(
    `/profiles/${encodeURIComponent(name)}/stamp/address`,
    { signal },
  );
}

export function fetchStampWallet(name: string, signal?: AbortSignal): Promise<BeeWallet> {
  return getJson<BeeWallet>(
    `/profiles/${encodeURIComponent(name)}/stamp/wallet`,
    { signal },
  );
}

export function fetchChainState(name: string, signal?: AbortSignal): Promise<BeeChainState> {
  return getJson<BeeChainState>(
    `/profiles/${encodeURIComponent(name)}/stamp/chainstate`,
    { signal },
  );
}

export async function fetchStamps(name: string, signal?: AbortSignal): Promise<BeeStamp[]> {
  const body = await getJson<{ stamps: BeeStamp[] }>(
    `/profiles/${encodeURIComponent(name)}/stamp/stamps`,
    { signal },
  );
  return body.stamps;
}

export function buyStamp(
  name: string,
  input: BuyStampInput,
): Promise<{ batchID: string }> {
  return sendJson<{ batchID: string }>(
    'POST',
    `/profiles/${encodeURIComponent(name)}/stamp/buy`,
    input,
  );
}

/** Tops up a batch the deployment's own node holds, paid from that node's wallet. */
export function topUpStamp(
  name: string,
  request: TopUpStampRequest,
): Promise<BeeStampTransaction> {
  return sendJson<BeeStampTransaction>(
    'POST',
    `/profiles/${encodeURIComponent(name)}/stamp/topup`,
    request,
  );
}

/** Dilutes a batch the deployment's own node holds to a deeper depth. */
export function diluteStamp(
  name: string,
  request: DiluteStampRequest,
): Promise<BeeStampTransaction> {
  return sendJson<BeeStampTransaction>(
    'POST',
    `/profiles/${encodeURIComponent(name)}/stamp/dilute`,
    request,
  );
}

export function setStamp(name: string, stampId: string): Promise<Profile> {
  return sendJson<Profile>(
    'POST',
    `/profiles/${encodeURIComponent(name)}/stamp/set`,
    { stamp_id: stampId },
  );
}

export function fetchBeeNodeObservation(name: string, signal?: AbortSignal): Promise<BeeNodeObservation> {
  return getJson<BeeNodeObservation>(`/profiles/${encodeURIComponent(name)}/stamp/readiness`, { signal });
}
