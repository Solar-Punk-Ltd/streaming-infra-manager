import { useEffect, useState } from 'react';

import { getErrorMessage } from '@streaming-infra-manager/common';

import type { Profile } from '../types';
import { type EngineOverview, fetchEngine } from './engineApi';

export interface EngineOverviewLoad {
  /** Null until it arrives, and while there is no engine to ask about. */
  overview: EngineOverview | null;
  loadError: string | null;
}

/**
 * The manager's answer about a deployment's engine, loaded once for the page
 * and read by every card that names a setting, so all of them say the same
 * numbers. Reloads after a save: the profile's updated_at moves on every
 * write, and a drawer's save merges the new profile into the store.
 */
export function useEngineOverview(profile: Profile | null): EngineOverviewLoad {
  const [overview, setOverview] = useState<EngineOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const name = profile?.name ?? null;
  const updatedAt = profile?.updated_at ?? null;

  useEffect(() => {
    setOverview(null);
    setLoadError(null);
  }, [name]);

  useEffect(() => {
    if (name === null) return undefined;
    let current = true;
    fetchEngine(name)
      .then((loaded) => {
        if (current) {
          setOverview(loaded);
          setLoadError(null);
        }
      })
      .catch((caught) => {
        if (current) {
          setLoadError(getErrorMessage(caught, 'The manager did not say why.'));
        }
      });
    return () => {
      current = false;
    };
  }, [name, updatedAt]);

  return { overview, loadError };
}
