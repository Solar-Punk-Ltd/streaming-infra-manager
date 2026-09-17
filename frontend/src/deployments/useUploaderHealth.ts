import { useEffect, useState } from 'react';

import type { UploaderHealthReading } from '@streaming-infra-manager/common';

import type { Profile } from '../types';
import { NODE_REFRESH_INTERVAL_MS } from '../uploaders/beeReadiness';
import { fetchUploaderHealth } from './uploaderHealthApi';

/**
 * What the deployment's uploader says about itself, re-read on the same cadence
 * as the node readings beside it.
 *
 * `undefined` until an answer arrives, and again whenever one cannot be
 * obtained. That is the same rule the node readings keep: a reading nobody
 * could confirm is not evidence, and leaving the last one on screen would show
 * a wait that may have ended a minute ago. The step falls back to what a
 * running container proves on its own.
 *
 * @param profile the deployment to ask about, or null for a view with no
 *   uploader to ask, which asks nothing at all.
 */
export function useUploaderHealth(
  profile: Profile | null,
): UploaderHealthReading | undefined {
  const [reading, setReading] = useState<UploaderHealthReading | undefined>(undefined);
  const name = profile?.name ?? null;

  useEffect(() => {
    if (name === null) {
      setReading(undefined);
      return undefined;
    }

    let current = true;
    const controller = new AbortController();
    const read = async () => {
      try {
        const answer = await fetchUploaderHealth(name, controller.signal);
        if (current) setReading(answer);
      } catch {
        if (current) setReading(undefined);
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

  return reading;
}
