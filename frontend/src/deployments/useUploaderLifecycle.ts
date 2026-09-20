import { useEffect, useRef, useState } from 'react';

import {
  UPLOADER_LIFECYCLE_STALE_AFTER_MS,
  type UploaderLifecycleReading,
  type UploaderLifecycleState,
} from '@streaming-infra-manager/common';

import { getJson } from '../http';
import type { Profile } from '../types';

const ACTIVE_STATES = new Set<UploaderLifecycleState>([
  'ready',
  'claimed',
  'live',
  'waiting',
]);

interface UploaderLifecyclePollingPolicy {
  pollEveryMs: number;
  staleAfterMs: number;
}

const DEFAULT_POLICY: UploaderLifecyclePollingPolicy = {
  pollEveryMs: 10_000,
  staleAfterMs: UPLOADER_LIFECYCLE_STALE_AFTER_MS,
};

interface LifecycleSnapshot {
  identity: string;
  reading: UploaderLifecycleReading;
}

/** Reads only the current deployment identity and discards superseded polls. */
export function useUploaderLifecycle(
  profile: Profile | null,
  enabled: boolean,
  policy: UploaderLifecyclePollingPolicy = DEFAULT_POLICY,
): UploaderLifecycleReading | undefined {
  const profileName = profile?.name ?? null;
  const identity =
    profile && enabled ? `${profileName}\u0000${profile.instance_id}` : null;
  const [snapshot, setSnapshot] = useState<LifecycleSnapshot>();
  const generation = useRef(0);

  useEffect(() => {
    const currentGeneration = ++generation.current;
    if (!profileName || !identity) {
      setSnapshot(undefined);
      return;
    }

    const controller = new AbortController();
    let latestRequest = 0;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const clearExpiry = () => {
      if (expiry) clearTimeout(expiry);
      expiry = undefined;
    };
    const isCurrent = () => generation.current === currentGeneration;
    const accept = (
      reading: UploaderLifecycleReading,
      requestElapsedMs = 0,
    ) => {
      if (!isCurrent()) return;
      clearExpiry();
      setSnapshot({ identity, reading });

      const remainingMs = activeFreshnessRemaining(
        reading,
        policy.staleAfterMs,
        requestElapsedMs,
      );
      if (remainingMs === null) return;
      if (remainingMs <= 0) {
        setSnapshot({ identity, reading: { state: 'unavailable' } });
        return;
      }
      expiry = setTimeout(() => {
        if (isCurrent()) {
          setSnapshot({ identity, reading: { state: 'unavailable' } });
        }
      }, remainingMs);
    };
    const read = async () => {
      const request = ++latestRequest;
      const requestedAt = performance.now();
      try {
        const result = await getJson<UploaderLifecycleReading>(
          `/profiles/${encodeURIComponent(profileName)}/uploader-lifecycle`,
          { cache: 'no-store', signal: controller.signal },
        );
        if (request === latestRequest) {
          accept(result, Math.max(0, performance.now() - requestedAt));
        }
      } catch {
        if (request === latestRequest && isCurrent()) {
          accept({ state: 'unavailable' });
        }
      }
    };

    void read();
    const poll = setInterval(() => void read(), policy.pollEveryMs);
    return () => {
      ++generation.current;
      clearInterval(poll);
      clearExpiry();
      controller.abort();
    };
  }, [identity, policy.pollEveryMs, policy.staleAfterMs, profileName]);

  return identity && snapshot?.identity === identity
    ? snapshot.reading
    : undefined;
}

function activeFreshnessRemaining(
  reading: UploaderLifecycleReading,
  staleAfterMs: number,
  requestElapsedMs: number,
): number | null {
  if (reading.state === 'unavailable') return null;
  let remaining: number | null = null;
  for (const stream of reading.streams) {
    if (!ACTIVE_STATES.has(stream.state)) continue;
    if (!Number.isFinite(stream.initialAgeMs) || stream.initialAgeMs < 0) {
      return 0;
    }
    remaining = Math.min(
      remaining ?? staleAfterMs,
      staleAfterMs - stream.initialAgeMs - requestElapsedMs,
    );
  }
  return remaining;
}
