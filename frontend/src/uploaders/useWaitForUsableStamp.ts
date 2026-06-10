import { useEffect, useState } from 'react';

import type { BeeStamp } from './stampApi';
import { sameBatch } from './StampTable';

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120;

export interface UsableStampWait {
  waitingBatch: string | null;
  waitForStamp: (batchID: string) => void;
}

/**
 * Tracks a freshly bought batch until the bee node reports it usable,
 * refreshing the stamp list on every poll. The wait ends when the batch
 * becomes usable, the profile gets a stamp set, or the attempts run out.
 */
export function useWaitForUsableStamp(
  refreshStamps: () => Promise<BeeStamp[]>,
  stampAlreadySet: boolean,
): UsableStampWait {
  const [waitingBatch, setWaitingBatch] = useState<string | null>(null);

  useEffect(() => {
    if (!waitingBatch) return;

    let attempts = 0;
    const poll = setInterval(async () => {
      attempts += 1;
      try {
        const stamps = await refreshStamps();
        const bought = stamps.find((s) => sameBatch(s.batchID, waitingBatch));
        if (bought?.usable || attempts >= MAX_POLL_ATTEMPTS) {
          setWaitingBatch(null);
        }
      } catch {
        if (attempts >= MAX_POLL_ATTEMPTS) setWaitingBatch(null);
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(poll);
  }, [waitingBatch, refreshStamps]);

  useEffect(() => {
    if (stampAlreadySet) setWaitingBatch(null);
  }, [stampAlreadySet]);

  return { waitingBatch, waitForStamp: setWaitingBatch };
}
