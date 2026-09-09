import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type ChequebookSummary,
  type BeeNodeObservation,
  hasStampId,
  sameBatchId,
  type TransferExpectation,
  transferOutcome,
  type TransferOutcome,
} from '@streaming-infra-manager/common';

import { ApiError } from '../http';
import type { Profile } from '../types';
import { fetchChequebook } from './chequebookApi';
import {
  type BeeAddress,
  type BeeChainState,
  type BeeStamp,
  type BeeWallet,
  fetchChainState,
  fetchBeeNodeObservation,
  fetchStampAddress,
  fetchStamps,
  fetchStampWallet,
} from './stampApi';

const STAMP_POLL_INTERVAL_MS = 5_000;
const STAMP_POLL_MAX_ATTEMPTS = 120;

const BALANCE_POLL_INTERVAL_MS = 3_000;

/**
 * How long to watch for a deposit or withdrawal to land.
 *
 * Bee answers the call once the transaction is submitted, not once it is mined,
 * and a Gnosis block takes about five seconds. Two minutes is far longer than
 * that needs, and short enough that a dialog waiting on a transaction which
 * never confirms gives the operator their page back.
 */
const BALANCE_WAIT_MS = 120_000;

/** The manager's code for a node that answered 503: up, still syncing. */
const NODE_NOT_READY_CODE = 'bee_node_not_ready';

function beeLoadError(reason: unknown): string {
  if (reason instanceof ApiError && reason.code === NODE_NOT_READY_CODE) {
    return "This deployment's Bee node has not finished initializing. No completion estimate is available. Check its API observation and container logs, then retry.";
  }
  return "This deployment's Bee node did not answer all required checks. Retry the node checks. Existing streams are left running.";
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface BeeUtils {
  nodeObservation: BeeNodeObservation | null;
  observationNow: number;
  observationReceivedAt: number | null;
  address: BeeAddress | null;
  wallet: BeeWallet | null;
  /**
   * The node's batches, or null for "we do not know".
   *
   * Nullable for the same reason `address`, `wallet` and `chainState` are, and
   * with more at stake: an empty list means the node holds no batches, so the
   * recorded one has expired and been dropped, whereas no answer means nothing
   * at all. Conflating the two reports a node that is slow, or that has just
   * stopped answering, as one with a dead batch, or worse keeps calling a
   * stale list verified.
   *
   * A failed fetch therefore clears this rather than leaving the last answer in
   * place: a list nobody can currently confirm is not evidence, and showing one
   * under a "node unreachable" banner is a contradiction.
   */
  stamps: BeeStamp[] | null;
  chainState: BeeChainState | null;
  /**
   * What the node can still pay peers with, or null when it did not say. The
   * same rule as `stamps`: an unanswered node reports nothing, never zero.
   */
  chequebook: ChequebookSummary | null;
  loading: boolean;
  loadError: string | null;
  reload: () => Promise<void>;
  waitingBatch: string | null;
  waitForStamp: (batchID: string) => void;
  /**
   * Watch the chequebook until a submitted transfer has landed, resolving
   * `settled` when it has and with what the last look said once the wait is
   * given up on.
   *
   * A node that stops answering leaves the wait at `unknown` rather than at a
   * verdict: the polling keeps going to the deadline, and the caller is told
   * the transfer could not be judged instead of that it went through.
   *
   * Aborting the signal calls the watch off. The transaction is on its way
   * either way, this only stops the polling and the state it would write.
   */
  waitForBalanceChange: (
    expectation: TransferExpectation,
    signal?: AbortSignal,
  ) => Promise<TransferOutcome>;
  /**
   * One more look at the chequebook, answering the same question the wait did:
   * has this transfer landed since it was submitted.
   *
   * For an operator asking again after the wait gave up. It reads, it never
   * submits anything.
   */
  recheckBalance: (
    expectation: TransferExpectation,
  ) => Promise<TransferOutcome>;
}

function isRejected(
  result: PromiseSettledResult<unknown>,
): result is PromiseRejectedResult {
  return result.status === 'rejected';
}

export interface BeeUtilsOptions {
  /**
   * Ask the node for its chequebook too. Off for a caller that is handed the
   * reading from somewhere else, so a page listing many nodes asks each of them
   * once rather than once per row.
   */
  withChequebook?: boolean;
}

/**
 * Loads the data a profile's bee node reports (address, wallet, stamps,
 * chequebook) and tracks a freshly bought batch until the node reports it
 * usable, refreshing the stamp list on every poll. Each piece is fetched
 * independently, so one failing endpoint still lets the others render. The
 * first failure becomes `loadError`. The wait ends when the batch becomes
 * usable, the profile gets a stamp set, or the attempts run out.
 *
 * A failed fetch clears `stamps` and `chequebook`, the two whose absence
 * nothing downstream may read as an answer: an unanswered node is never a node
 * with no batches, nor one with an empty chequebook. `wallet` and `chainState` are also cleared before a new check. The prior
 * node observation remains visible with its timestamp while the check runs.
 */
export function useBeeUtils(
  profile: Profile,
  { withChequebook = true }: BeeUtilsOptions = {},
): BeeUtils {
  const profileName = profile.name;
  const profileRevision = `${profile.status}:${profile.updated_at}`;
  const [nodeObservation, setNodeObservation] = useState<BeeNodeObservation | null>(null);
  const [observationReceivedAt, setObservationReceivedAt] = useState<number | null>(null);
  const [observationNow, setObservationNow] = useState(() => performance.now());
  useEffect(() => {
    const timer = setInterval(() => setObservationNow(performance.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const [address, setAddress] = useState<BeeAddress | null>(null);
  const [wallet, setWallet] = useState<BeeWallet | null>(null);
  const [stamps, setStamps] = useState<BeeStamp[] | null>(null);
  const [chainState, setChainState] = useState<BeeChainState | null>(null);
  const [chequebook, setChequebook] = useState<ChequebookSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [waitingBatch, setWaitingBatch] = useState<string | null>(null);

  // The waiting dialog compares against whatever was on screen when it started,
  // which a closure over state would read one render too late.
  const latestChequebook = useRef<ChequebookSummary | null>(null);
  const applyChequebook = useCallback((next: ChequebookSummary | null) => {
    latestChequebook.current = next;
    setChequebook(next);
  }, []);

  // What the chequebook said before the transfer was submitted. The wait and a
  // later "check again" answer against the same reading, so an operator who
  // asks after the wait gave up gets the verdict the wait was looking for.
  const beforeMove = useRef<ChequebookSummary | null>(null);

  // Which reload the answers belong to. Two can be in flight at once, from
  // StrictMode's double mount or from a balance wait refreshing the card while
  // the operator presses Refresh, and the slower one must not land last.
  const latestReload = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++latestReload.current;
    setLoading(true);
    setLoadError(null);
    setWallet(null);
    setStamps(null);
    setChainState(null);
    if (withChequebook) applyChequebook(null);

    const [
      observationResult,
      addressResult,
      walletResult,
      stampsResult,
      chainStateResult,
      chequebookResult,
    ] = await Promise.allSettled([
      fetchBeeNodeObservation(profileName).then(value => ({ value, receivedAt: performance.now() })),
      fetchStampAddress(profileName),
      fetchStampWallet(profileName),
      fetchStamps(profileName),
      fetchChainState(profileName),
      withChequebook ? fetchChequebook(profileName) : Promise.resolve(null),
    ]);

    if (seq !== latestReload.current) return;

    setNodeObservation(observationResult.status === 'fulfilled' ? observationResult.value.value : null);
    setObservationReceivedAt(observationResult.status === 'fulfilled' ? observationResult.value.receivedAt : null);
    setObservationNow(performance.now());
    if (addressResult.status === 'fulfilled') setAddress(addressResult.value);
    if (walletResult.status === 'fulfilled') setWallet(walletResult.value);
    setStamps(
      stampsResult.status === 'fulfilled' ? stampsResult.value : null,
    );
    if (chainStateResult.status === 'fulfilled')
      setChainState(chainStateResult.value);
    if (withChequebook) {
      applyChequebook(
        chequebookResult.status === 'fulfilled' ? chequebookResult.value : null,
      );
    }

    const failure = [addressResult, walletResult, stampsResult].find(
      isRejected,
    );
    if (failure) {
      setLoadError(beeLoadError(failure.reason));
    }

    setLoading(false);
  }, [profileName, profileRevision, withChequebook, applyChequebook]);

  useEffect(() => {
    void reload();
    return () => { latestReload.current += 1; };
  }, [reload]);

  const recheckBalance = useCallback(
    async (expectation: TransferExpectation): Promise<TransferOutcome> => {
      let fresh: ChequebookSummary;
      try {
        fresh = await fetchChequebook(profileName);
      } catch {
        applyChequebook(null);
        return 'unknown';
      }

      applyChequebook(fresh);
      const outcome = transferOutcome(beforeMove.current, fresh, expectation);
      if (outcome !== 'settled') return outcome;

      // A deposit empties the wallet by the same amount, so the whole card is
      // refreshed rather than only the half that was watched.
      await reload();
      return 'settled';
    },
    [profileName, applyChequebook, reload],
  );

  const waitForBalanceChange = useCallback(
    async (expectation: TransferExpectation, signal?: AbortSignal) => {
      beforeMove.current = latestChequebook.current;
      const deadline = Date.now() + BALANCE_WAIT_MS;
      let latest: TransferOutcome = 'unknown';

      while (Date.now() < deadline) {
        await sleep(BALANCE_POLL_INTERVAL_MS);
        if (signal?.aborted) return latest;
        latest = await recheckBalance(expectation);
        if (latest === 'settled') return 'settled';
        if (signal?.aborted) return latest;
      }
      return latest;
    },
    [recheckBalance],
  );

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
    nodeObservation,
    observationNow,
    observationReceivedAt,
    address,
    wallet,
    stamps,
    chainState,
    chequebook,
    loading,
    loadError,
    reload,
    waitingBatch,
    waitForStamp: setWaitingBatch,
    waitForBalanceChange,
    recheckBalance,
  };
}
