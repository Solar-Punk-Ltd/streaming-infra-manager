import type { BeeNodeObservation } from '@streaming-infra-manager/common';
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

export function fetchStampAddress(name: string): Promise<BeeAddress> {
  return getJson<BeeAddress>(
    `/profiles/${encodeURIComponent(name)}/stamp/address`,
  );
}

export function fetchStampWallet(name: string): Promise<BeeWallet> {
  return getJson<BeeWallet>(
    `/profiles/${encodeURIComponent(name)}/stamp/wallet`,
  );
}

export function fetchChainState(name: string): Promise<BeeChainState> {
  return getJson<BeeChainState>(
    `/profiles/${encodeURIComponent(name)}/stamp/chainstate`,
  );
}

export async function fetchStamps(name: string): Promise<BeeStamp[]> {
  const body = await getJson<{ stamps: BeeStamp[] }>(
    `/profiles/${encodeURIComponent(name)}/stamp/stamps`,
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

export function setStamp(name: string, stampId: string): Promise<Profile> {
  return sendJson<Profile>(
    'POST',
    `/profiles/${encodeURIComponent(name)}/stamp/set`,
    { stamp_id: stampId },
  );
}

export function fetchBeeNodeObservation(name: string): Promise<BeeNodeObservation> {
  return getJson<BeeNodeObservation>(`/profiles/${encodeURIComponent(name)}/stamp/readiness`);
}
