import type { Profile } from '../types';
import { extractApiError, getJson } from '../http';

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

export async function fetchStamps(name: string): Promise<BeeStamp[]> {
  const body = await getJson<{ stamps: BeeStamp[] }>(
    `/profiles/${encodeURIComponent(name)}/stamp/stamps`,
  );
  return body.stamps;
}

export async function buyStamp(
  name: string,
  input: BuyStampInput,
): Promise<{ batchID: string }> {
  const res = await fetch(`/profiles/${encodeURIComponent(name)}/stamp/buy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(await extractApiError(res, `buy failed (${res.status})`));
  }
  return (await res.json()) as { batchID: string };
}

export async function setStamp(
  name: string,
  stampId: string,
): Promise<Profile> {
  const res = await fetch(`/profiles/${encodeURIComponent(name)}/stamp/set`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stamp_id: stampId }),
  });
  if (!res.ok) {
    throw new Error(
      await extractApiError(res, `set stamp failed (${res.status})`),
    );
  }
  return (await res.json()) as Profile;
}
