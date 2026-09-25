import { useEffect, useState } from 'react';

import { getErrorMessage } from '@streaming-infra-manager/common';

import type { Profile } from '../types';
import { NODE_REFRESH_INTERVAL_MS } from '../uploaders/beeReadiness';
import { fetchSrtIngest } from './srtIngestApi';
import type { SrtIngestLoad } from './srtIngestText';

const NOT_READ: SrtIngestLoad = { reading: null, loadError: null };

/**
 * The SRT link reading, asked again on the cadence of the node readings beside
 * it, which is also about how often SRS prints a report.
 *
 * A failed ask clears the last reading rather than leaving it on screen, the
 * rule the uploader health keeps: a link reading nobody could confirm may
 * describe a broadcast that ended a minute ago. A new ask waits for the last
 * one to answer, because each one reads the engine's log.
 *
 * @param profile the deployment to ask about, or null for one with no SRS
 *   running, which asks nothing at all.
 */
export function useSrtIngestHealth(profile: Profile | null): SrtIngestLoad {
  const [load, setLoad] = useState<SrtIngestLoad>(NOT_READ);
  const name = profile?.name ?? null;

  useEffect(() => {
    if (name === null) {
      setLoad(NOT_READ);
      return undefined;
    }

    let current = true;
    let asking = false;
    const controller = new AbortController();
    const read = async () => {
      if (asking) return;
      asking = true;
      try {
        const reading = await fetchSrtIngest(name, controller.signal);
        if (current) setLoad({ reading, loadError: null });
      } catch (caught) {
        if (current) {
          setLoad({ reading: null, loadError: getErrorMessage(caught, 'The manager did not say why.') });
        }
      } finally {
        asking = false;
      }
    };

    void read();
    const timer = setInterval(() => void read(), NODE_REFRESH_INTERVAL_MS);
    return () => {
      current = false;
      clearInterval(timer);
      controller.abort();
    };
  }, [name]);

  return load;
}
