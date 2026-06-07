import { useCallback, useEffect, useRef, useState } from 'react';

import type { MetricsSnapshot } from './types';

/** How many recent CPU samples to keep per container for sparklines. */
const HISTORY_LEN = 40;

export interface UseMetrics {
  snapshot: MetricsSnapshot | null;
  /** containerId → recent cpuPercent samples (oldest first). */
  history: Map<string, number[]>;
  connected: boolean;
  /** Lazily fetch a profile's on-disk footprint (bytes, or null). */
  fetchDisk: (project: string) => Promise<number | null>;
}

/**
 * Subscribes to the manager's metrics SSE stream while mounted (which also
 * gates the backend's sampling — it stops polling Docker when no one is
 * watching) and maintains a short per-container CPU history for sparklines.
 */
export function useMetrics(): UseMetrics {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const historyRef = useRef<Map<string, number[]>>(new Map());

  useEffect(() => {
    const source = new EventSource('/metrics/stream');

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    source.addEventListener('snapshot', (ev: MessageEvent<string>) => {
      const snap = JSON.parse(ev.data) as MetricsSnapshot;

      const history = historyRef.current;
      const seen = new Set<string>();
      for (const c of snap.containers) {
        seen.add(c.id);
        const arr = history.get(c.id) ?? [];
        arr.push(c.cpuPercent);
        if (arr.length > HISTORY_LEN) arr.splice(0, arr.length - HISTORY_LEN);
        history.set(c.id, arr);
      }
      // Forget containers that are gone.
      for (const id of [...history.keys()]) {
        if (!seen.has(id)) history.delete(id);
      }

      setSnapshot(snap);
    });

    return () => source.close();
  }, []);

  const fetchDisk = useCallback(
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

  return { snapshot, history: historyRef.current, connected, fetchDisk };
}
