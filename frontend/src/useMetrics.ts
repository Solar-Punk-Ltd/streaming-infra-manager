import { useCallback, useEffect, useRef, useState } from 'react';

import type { MetricsSnapshot } from './types';

const HISTORY_LEN = 40;

export type CpuHistoryByContainer = Map<string, number[]>;

export interface UseMetrics {
  snapshot: MetricsSnapshot | null;
  history: CpuHistoryByContainer;
  connected: boolean;
  fetchProfileDiskBytes: (project: string) => Promise<number | null>;
}

// Subscribing also gates the backend: it samples Docker only while someone listens.
export function useMetrics(): UseMetrics {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
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
    fetchProfileDiskBytes,
  };
}
