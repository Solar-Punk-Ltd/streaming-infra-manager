import { useEffect, useState } from 'react';

import { engineOverviewIdentityKey, getErrorMessage } from '@streaming-infra-manager/common';

import type { Profile } from '../types';
import { type EngineOverview, fetchEngine } from './engineApi';
import { engineOverviewRequestKey } from './engineOverviewRequest';

export interface EngineOverviewLoad {
  /** Null until it arrives, and while there is no engine to ask about. */
  overview: EngineOverview | null;
  loadError: string | null;
}

const READ_TIMEOUT_MS = 15_000;
interface IdentifiedLoad extends EngineOverviewLoad { requestedKey: string }

/** Old evidence is hidden during render, before a changed input's effect starts. */
export function useEngineOverview(profile: Profile | null): EngineOverviewLoad {
  const [load, setLoad] = useState<IdentifiedLoad | null>(null);
  const name = profile?.name ?? null;
  const requestedKey = engineOverviewRequestKey(profile);

  useEffect(() => {
    if (name === null || requestedKey === null) return undefined;
    let current = true;
    let timedOut = false;
    const controller = new AbortController();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, READ_TIMEOUT_MS);
    fetchEngine(name, controller.signal)
      .then((loaded) => {
        if (!current) return;
        if (!loaded.identity || engineOverviewIdentityKey(loaded.identity) !== requestedKey) {
          throw new Error('The deployment changed while its settings were read. Reload to get matching observations.');
        }
        setLoad({ requestedKey, overview: loaded, loadError: null });
      })
      .catch((caught) => {
        if (current) setLoad({ requestedKey, overview: null, loadError: timedOut
          ? 'Reading engine settings timed out. Reload to try again.'
          : getErrorMessage(caught, 'The manager did not say why.') });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      current = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [name, requestedKey]);

  return requestedKey !== null && load?.requestedKey === requestedKey
    ? { overview: load.overview, loadError: load.loadError }
    : { overview: null, loadError: profile && requestedKey === null
      ? 'The deployment metadata cannot identify current engine observations. Reload to read it again.' : null };
}
