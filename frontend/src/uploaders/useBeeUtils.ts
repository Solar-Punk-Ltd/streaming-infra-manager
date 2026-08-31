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
  /**
   * The node's batches, or null for "we do not know".
   *
   * Nullable for the same reason `address`, `wallet` and `chainState` are, and
   * with more at stake: an empty list means the node holds no batches, so the
   * recorded one has expired and been dropped, whereas no answer means nothing
   * at all. Conflating the two reports a node that is slow, or that has just
   * stopped answering, as one with a dead batch — or worse, keeps calling a
   * stale list verified.
   *
   * A failed fetch therefore clears this rather than leaving the last answer in
   * place: a list nobody can currently confirm is not evidence, and showing one
   * under a "node unreachable" banner is a contradiction.
   */
  stamps: BeeStamp[] | null;
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
 *
 * One rule throughout: a stamps fetch that failed sets `stamps` to null. Nothing
 * downstream may treat an unanswered node as a node with no batches.
 */
export function useBeeUtils(profile: Profile): BeeUtils {
  const profileName = profile.name;

  const [address, setAddress] = useState<BeeAddress | null>(null);
  const [wallet, setWallet] = useState<BeeWallet | null>(null);
  const [stamps, setStamps] = useState<BeeStamp[] | null>(null);
  const [chainState, setChainState] = useState<BeeChainState | null>(null);
  const [loading, setLoading] = useState(true);
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
    setStamps(
      stampsResult.status === 'fulfilled' ? stampsResult.value : null,
    );
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
        const bought = fresh.find((s) => sameBatchId(s.batchID, waitingBatch));
        if (bought?.usable || attempts >= STAMP_POLL_MAX_ATTEMPTS) {
          setWaitingBatch(null);
        }
      } catch {
        // Same rule as reload: a fetch that failed tells us nothing about the
        // node's batches, so it must not leave the previous answer standing.
        setStamps(null);
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
    chainState,
    loading,
    loadError,
    reload,
    waitingBatch,
    waitForStamp: setWaitingBatch,
  };
}
