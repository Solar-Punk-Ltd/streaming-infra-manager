import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type BeePublishersResult,
  getErrorMessage,
  isLadderKind,
} from '@streaming-infra-manager/common';

import { fetchBeePublishers } from '../data';
import type { DeploymentGroup, Profile } from '../types';

export interface BeePublishersState {
  result: BeePublishersResult | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

/**
 * The pool string for one group, re-assembled whenever a rung's stamp changes.
 *
 * Two of these can be in flight at once, because each rung auto-stamping
 * publishes its own event, and they can finish out of order. The sequence
 * number keeps the older answer from landing last and pinning the card to a
 * readiness that is already wrong.
 */
export function useBeePublishers(
  groupId: number | null,
  stampFingerprint: string,
): BeePublishersState {
  const [result, setResult] = useState<BeePublishersResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const reload = useCallback(async () => {
    if (groupId == null) {
      setResult(null);
      return;
    }
    const seq = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchBeePublishers(groupId);
      if (seq !== latest.current) return;
      setResult(next);
    } catch (caught) {
      if (seq !== latest.current) return;
      setError(getErrorMessage(caught));
      setResult(null);
    } finally {
      if (seq === latest.current) setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    void reload();
  }, [reload, stampFingerprint]);

  return { result, loading, error, reload };
}

export type PoolResults = ReadonlyMap<number, BeePublishersResult | null>;

/**
 * The same answer for every pool at once, for the overview's attention list.
 *
 * One effect rather than a hook per pool: the number of pools changes as groups
 * come and go, and hooks cannot be called in a loop that varies.
 */
export function usePoolResults(
  groups: DeploymentGroup[],
  profiles: Profile[] | null,
): PoolResults {
  const [results, setResults] = useState<PoolResults>(new Map());

  const poolIds = groups
    .filter((group) => isLadderKind(group.kind))
    .map((group) => group.id);
  const poolKey = poolIds.join(',');

  const memberFingerprint = (profiles ?? [])
    .filter((profile) => profile.group_id != null)
    .map((profile) => `${profile.name}:${profile.stamp_id ?? ''}:${profile.status}`)
    .join('|');

  useEffect(() => {
    let cancelled = false;
    const ids = poolKey ? poolKey.split(',').map(Number) : [];

    void Promise.all(
      ids.map(async (id) => {
        try {
          return [id, await fetchBeePublishers(id)] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setResults(new Map(entries));
    });

    return () => {
      cancelled = true;
    };
  }, [poolKey, memberFingerprint]);

  return results;
}
