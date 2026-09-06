import { useEffect, useState } from 'react';

import {
  type ChequebookHealth,
  chequebookHealthFromPayload,
} from '@streaming-infra-manager/common';

import { ownsBeeNode } from '../deployments/readiness';
import { isRunning } from '../deployments/shape';
import type { Profile } from '../types';
import { fetchChequebook } from './chequebookApi';

/** What each node said about its chequebook, by profile name. */
export type ChequebookHealths = ReadonlyMap<string, ChequebookHealth>;

/**
 * How often the readings are taken again while the page stays open.
 *
 * A chequebook drains as the node pays for what it forwards, and it is filled
 * from another tab or from the host. The pages that show these numbers are the
 * ones an operator leaves open while doing exactly that, so a reading taken
 * once at mount is stale within minutes and says nothing about it.
 */
const REFRESH_MS = 30_000;

/**
 * Ask every deployment that owns a Bee node what its chequebook holds, for the
 * pages that list many at once.
 *
 * One effect rather than a hook per row: the list changes as deployments come
 * and go, and hooks cannot be called in a loop that varies. A node that does
 * not answer is simply absent from the map, which is what keeps a page from
 * labelling an unreachable node as one with an empty chequebook.
 *
 * Only running deployments are asked. A stopped one has nothing listening, so
 * the request could only ever fail.
 */
export function useChequebookHealths(
  profiles: Profile[] | null,
): ChequebookHealths {
  const [healths, setHealths] = useState<ChequebookHealths>(new Map());

  const askable = (profiles ?? [])
    .filter((profile) => ownsBeeNode(profile) && isRunning(profile))
    .map((profile) => profile.name);
  const askableKey = askable.join(',');

  useEffect(() => {
    let cancelled = false;
    const names = askableKey ? askableKey.split(',') : [];

    const askEveryone = async () => {
      const entries = await Promise.all(
        names.map(async (name) => {
          try {
            const summary = await fetchChequebook(name);
            return [name, chequebookHealthFromPayload(summary.health)] as const;
          } catch {
            return [name, null] as const;
          }
        }),
      );
      if (cancelled) return;
      setHealths(
        new Map(
          entries.filter(
            (entry): entry is readonly [string, ChequebookHealth] =>
              entry[1] !== null,
          ),
        ),
      );
    };

    void askEveryone();
    const timer = setInterval(() => void askEveryone(), REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [askableKey]);

  return healths;
}
