import { useCallback, useEffect, useState } from 'react';

import {
  getErrorMessage,
  hasStampId,
  sameBatchId,
} from '@streaming-infra-manager/common';

import type { Profile } from '../types';
import {
  type BeeAddress,
  type BeeChainState,
  type BeeStamp,
  type BeeWallet,
  fetchChainState,
  fetchStampAddress,
  fetchStamps,
  fetchStampWallet,
} from './stampApi';

const STAMP_POLL_INTERVAL_MS = 5_000;
const STAMP_POLL_MAX_ATTEMPTS = 120;

export interface BeeUtils {
  address: BeeAddress | null;
  wallet: BeeWallet | null;
  stamps: BeeStamp[];
  /**
   * Whether `stamps` is the node's answer or just the starting empty array.
   *
   * An empty list means the node holds no batches — the recorded one has expired
   * and been dropped. Not having asked yet means nothing at all, and reporting
   * the second as the first is how a node that is merely slow gets shown as one
   * with a dead batch.
   */
  stampsLoaded: boolean;
  chainState: BeeChainState | null;
  loading: boolean;
  loadError: string | null;
  reload: () => Promise<void>;
  waitingBatch: string | null;
  waitForStamp: (batchID: string) => void;
}

function isRejected(
  result: PromiseSettledResult<unknown>,
): result is PromiseRejectedResult {
  return result.status === 'rejected';
}

/**
 * Loads the data a profile's bee node reports (address, wallet, stamps) and
 * tracks a freshly bought batch until the node reports it usable, refreshing
 * the stamp list on every poll. Each piece is fetched independently, so one
 * failing endpoint still lets the others render; the first failure becomes
 * `loadError`. The wait ends when the batch becomes usable, the profile gets
 * a stamp set, or the attempts run out.
 */
export function useBeeUtils(profile: Profile): BeeUtils {
  const profileName = profile.name;

  const [address, setAddress] = useState<BeeAddress | null>(null);
  const [wallet, setWallet] = useState<BeeWallet | null>(null);
  const [stamps, setStamps] = useState<BeeStamp[]>([]);
  const [stampsLoaded, setStampsLoaded] = useState(false);
  const [chainState, setChainState] = useState<BeeChainState | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [waitingBatch, setWaitingBatch] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);

    const [addressResult, walletResult, stampsResult, chainStateResult] =
      await Promise.allSettled([
        fetchStampAddress(profileName),
        fetchStampWallet(profileName),
        fetchStamps(profileName),
        fetchChainState(profileName),
      ]);

    if (addressResult.status === 'fulfilled') setAddress(addressResult.value);
    if (walletResult.status === 'fulfilled') setWallet(walletResult.value);
    if (stampsResult.status === 'fulfilled') {
      setStamps(stampsResult.value);
      setStampsLoaded(true);
    }
    if (chainStateResult.status === 'fulfilled')
      setChainState(chainStateResult.value);

    const failure = [addressResult, walletResult, stampsResult].find(
      isRejected,
    );
    if (failure) {
      setLoadError(`bee node unreachable — ${getErrorMessage(failure.reason)}`);
    }

    setLoading(false);
  }, [profileName]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!waitingBatch) return;

    let attempts = 0;
    const poll = setInterval(async () => {
      attempts += 1;
      try {
        const fresh = await fetchStamps(profileName);
        setStamps(fresh);
        setStampsLoaded(true);
        const bought = fresh.find((s) => sameBatchId(s.batchID, waitingBatch));
        if (bought?.usable || attempts >= STAMP_POLL_MAX_ATTEMPTS) {
          setWaitingBatch(null);
        }
      } catch {
        if (attempts >= STAMP_POLL_MAX_ATTEMPTS) setWaitingBatch(null);
      }
    }, STAMP_POLL_INTERVAL_MS);

    return () => clearInterval(poll);
  }, [waitingBatch, profileName]);

  const stampSet = hasStampId(profile);
  useEffect(() => {
    if (stampSet) setWaitingBatch(null);
  }, [stampSet]);

  return {
    address,
    wallet,
    stamps,
    stampsLoaded,
    chainState,
    loading,
    loadError,
    reload,
    waitingBatch,
    waitForStamp: setWaitingBatch,
  };
}
