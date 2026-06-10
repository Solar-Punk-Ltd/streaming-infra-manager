import { useCallback, useEffect, useState } from 'react';

import { getErrorMessage } from '@streaming-infra-manager/common';

import {
  type BeeAddress,
  type BeeStamp,
  type BeeWallet,
  fetchStampAddress,
  fetchStamps,
  fetchStampWallet,
} from './stampApi';

export interface BeeNodeState {
  address: BeeAddress | null;
  wallet: BeeWallet | null;
  stamps: BeeStamp[];
  loading: boolean;
  loadError: string | null;
  reload: () => Promise<void>;
  refreshStamps: () => Promise<BeeStamp[]>;
}

function isRejected(
  result: PromiseSettledResult<unknown>,
): result is PromiseRejectedResult {
  return result.status === 'rejected';
}

/**
 * Loads a profile's bee node data (address, wallet, stamps) on mount and on
 * `reload()`. Each piece is fetched independently, so one failing endpoint
 * still lets the others render; the first failure becomes `loadError`.
 */
export function useBeeNode(profileName: string): BeeNodeState {
  const [address, setAddress] = useState<BeeAddress | null>(null);
  const [wallet, setWallet] = useState<BeeWallet | null>(null);
  const [stamps, setStamps] = useState<BeeStamp[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);

    const [addressResult, walletResult, stampsResult] =
      await Promise.allSettled([
        fetchStampAddress(profileName),
        fetchStampWallet(profileName),
        fetchStamps(profileName),
      ]);

    if (addressResult.status === 'fulfilled') setAddress(addressResult.value);
    if (walletResult.status === 'fulfilled') setWallet(walletResult.value);
    if (stampsResult.status === 'fulfilled') setStamps(stampsResult.value);

    const failure = [addressResult, walletResult, stampsResult].find(
      isRejected,
    );
    if (failure) {
      setLoadError(`bee node unreachable — ${getErrorMessage(failure.reason)}`);
    }

    setLoading(false);
  }, [profileName]);

  const refreshStamps = useCallback(async () => {
    const fresh = await fetchStamps(profileName);
    setStamps(fresh);
    return fresh;
  }, [profileName]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { address, wallet, stamps, loading, loadError, reload, refreshStamps };
}
