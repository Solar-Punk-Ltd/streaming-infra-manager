import { useEffect, useState } from 'react';

import { type StampHealth, stampHealthFrom } from '@streaming-infra-manager/common';

import { ownsBeeNode } from '../deployments/readiness';
import { isRunning } from '../deployments/shape';
import type { Profile } from '../types';
import { fetchStamps } from './stampApi';

/** What each node said about the batch its profile records, by profile name. */
export type StampHealths = ReadonlyMap<string, StampHealth>;

/** One deployment to ask, and the batch it records at the time of asking. */
export interface StampAsk {
  name: string;
  stampId: string;
}

/**
 * How often the readings are taken again while the page stays open.
 *
 * Four times slower than the chequebook's, because the two decay differently. A
 * chequebook drains while an operator watches, and is filled from another tab.
 * A batch runs down on a clock nobody can speed up, and the states worth acting
 * on, expired and gone, arrive once and stay.
 */
const REFRESH_MS = 120_000;

const ASK_SEPARATOR = ',';
const BATCH_SEPARATOR = '=';

/**
 * Which deployments a list can ask about a batch, and about which one.
 *
 * A node that records no batch is left out rather than asked: `none` is already
 * the answer, and it is knowable without a request. A deployment that runs no
 * Bee node of its own has no API to ask, and a stopped one has nothing
 * listening, so a request could only ever fail.
 */
export function askableStamps(profiles: Profile[] | null): StampAsk[] {
  return (profiles ?? [])
    .filter((profile) => ownsBeeNode(profile) && isRunning(profile))
    .map((profile) => ({ name: profile.name, stampId: profile.stamp_id?.trim() ?? '' }))
    .filter((ask): ask is StampAsk => ask.stampId !== '');
}

/**
 * The asks as one string, so the effect below depends on a value rather than on
 * an array it would rebuild on every render. The batch is in it because a node
 * that has just bought one has to be asked again about that one.
 */
export function stampAskKey(asks: readonly StampAsk[]): string {
  return asks
    .map((ask) => `${ask.name}${BATCH_SEPARATOR}${ask.stampId}`)
    .join(ASK_SEPARATOR);
}

export function asksFromKey(key: string): StampAsk[] {
  if (!key) return [];
  return key.split(ASK_SEPARATOR).map((entry) => {
    const at = entry.indexOf(BATCH_SEPARATOR);
    return { name: entry.slice(0, at), stampId: entry.slice(at + 1) };
  });
}

/** What a round of answers is worth, with the nodes that gave none left out. */
export function stampHealthsFrom(
  answers: readonly (readonly [string, StampHealth | null])[],
): StampHealths {
  return new Map(
    answers.filter(
      (answer): answer is readonly [string, StampHealth] => answer[1] !== null,
    ),
  );
}

/**
 * Ask every running Bee node what the batch its profile records is worth, for
 * the pages that list many deployments at once.
 *
 * One effect rather than a hook per row, for the reason `useChequebookHealths`
 * gives: the list changes as deployments come and go, and hooks cannot be
 * called in a loop that varies. A node that does not answer is absent from the
 * map, which is what keeps a list from reporting an unreachable node's batch as
 * one that has expired.
 */
export function useStampHealths(profiles: Profile[] | null): StampHealths {
  const [healths, setHealths] = useState<StampHealths>(new Map());
  const askKey = stampAskKey(askableStamps(profiles));

  useEffect(() => {
    let cancelled = false;
    const asks = asksFromKey(askKey);

    const askEveryone = async () => {
      const answers = await Promise.all(
        asks.map(async ({ name, stampId }) => {
          try {
            return [name, stampHealthFrom(stampId, await fetchStamps(name))] as const;
          } catch {
            return [name, null] as const;
          }
        }),
      );
      if (cancelled) return;
      setHealths(stampHealthsFrom(answers));
    };

    void askEveryone();
    const timer = setInterval(() => void askEveryone(), REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [askKey]);

  return healths;
}
