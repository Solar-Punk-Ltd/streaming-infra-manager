import { useCallback, useEffect, useRef, useState } from 'react';

import { METRICS_SAMPLE_INTERVAL_MS } from '@streaming-infra-manager/common';

import type { MetricsSnapshot } from './types';

const HISTORY_LEN = 40;

/** Three samples missed, so one slow sample does not raise it. */
const STALE_AFTER_MS = 3 * METRICS_SAMPLE_INTERVAL_MS;
const STALE_CHECK_MS = 1_000;

export type CpuHistoryByContainer = Map<string, number[]>;

export interface UseMetrics {
  snapshot: MetricsSnapshot | null;
  history: CpuHistoryByContainer;
  connected: boolean;
  /** No sample has arrived for several intervals, so the numbers are not live. */
  stale: boolean;
  /** Age of the newest sample in whole seconds. 0 while the numbers are live. */
  staleSeconds: number;
  fetchProfileDiskBytes: (project: string) => Promise<number | null>;
}

/**
 * The live resource numbers.
 *
 * Subscribing also gates the backend: it samples Docker only while someone
 * listens. An open stream is not proof the numbers are moving, because the
 * manager heartbeats it whether or not a sample lands, so the age of the newest
 * one is tracked as well.
 */
export function useMetrics(): UseMetrics {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [staleAgeMs, setStaleAgeMs] = useState<number | null>(null);
  const historyRef = useRef<CpuHistoryByContainer>(new Map());

  useEffect(() => {
    const source = new EventSource('/metrics/stream');

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    source.addEventListener('snapshot', (ev: MessageEvent<string>) => {
      let snap: MetricsSnapshot;
      try {
        snap = JSON.parse(ev.data) as MetricsSnapshot;
      } catch {
        return;
      }

      const history = historyRef.current;
      const seen = new Set<string>();
      for (const c of snap.containers) {
        seen.add(c.id);
        const arr = history.get(c.id) ?? [];
        arr.push(c.cpuPercent);
        if (arr.length > HISTORY_LEN) arr.splice(0, arr.length - HISTORY_LEN);
        history.set(c.id, arr);
      }
      for (const id of [...history.keys()]) {
        if (!seen.has(id)) history.delete(id);
      }

      setSnapshot(snap);
    });

    return () => source.close();
  }, []);

  // On a timer of its own: nothing arrives while readings are stalled, so
  // nothing else would re-render the age.
  useEffect(() => {
    if (!snapshot) {
      setStaleAgeMs(null);
      return;
    }

    const sampledAt = Date.parse(snapshot.timestamp);
    const check = (): void => {
      const ageMs = Date.now() - sampledAt;
      setStaleAgeMs(ageMs >= STALE_AFTER_MS ? ageMs : null);
    };

    check();
    const timer = setInterval(check, STALE_CHECK_MS);
    return () => clearInterval(timer);
  }, [snapshot]);

  const fetchProfileDiskBytes = useCallback(
    async (project: string): Promise<number | null> => {
      try {
        const res = await fetch(`/metrics/disk/${encodeURIComponent(project)}`);
        if (!res.ok) return null;
        const body = (await res.json()) as { sizeBytes: number | null };
        return body.sizeBytes;
      } catch {
        return null;
      }
    },
    [],
  );

  return {
    snapshot,
    history: historyRef.current,
    connected,
    stale: staleAgeMs !== null,
    staleSeconds: staleAgeMs === null ? 0 : Math.round(staleAgeMs / 1_000),
    fetchProfileDiskBytes,
  };
}
