import { useCallback, useEffect, useRef, useState } from 'react';

import { type DeploymentSettingsCatalog, getErrorMessage } from '@streaming-infra-manager/common';

import { ApiError } from '../../http';
import type { Profile } from '../../types';
import { fetchDeploymentSettings } from './deploymentSettingsApi';
import { type LoadFailure, loadFailureOf } from './settingsText';

const READ_TIMEOUT_MS = 15_000;

const TIMED_OUT = 'The manager did not answer in time. Try again.';

export interface DeploymentSettingsLoad {
  /** The list as last read, kept while the next read is on its way so the page does not blank out. */
  catalog: DeploymentSettingsCatalog | null;
  /** Why the latest read failed, or null. */
  failure: LoadFailure | null;
  /** Reads the list again, and resolves once the answer or the failure is in place. */
  reload: () => Promise<void>;
}

/**
 * A deployment's settings list, read when the page opens and again whenever
 * the deployment's status moves. Apply and Start both go through a deploy, and
 * the list is what says which settings the containers it started are behind
 * on, so a list read before the deploy landed is out of date the moment it
 * lands. Only the newest read's answer is kept.
 */
export function useDeploymentSettings(profile: Profile): DeploymentSettingsLoad {
  const { name, status } = profile;
  const [catalog, setCatalog] = useState<DeploymentSettingsCatalog | null>(null);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const latest = useRef(0);
  const inFlight = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    latest.current += 1;
    const request = latest.current;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, READ_TIMEOUT_MS);
    try {
      const answer = await fetchDeploymentSettings(name, controller.signal);
      if (request !== latest.current) return;
      setCatalog(answer);
      setFailure(null);
    } catch (caught) {
      if (request !== latest.current) return;
      setFailure(
        caught instanceof ApiError
          ? loadFailureOf(caught.code, caught.message)
          : loadFailureOf(null, timedOut ? TIMED_OUT : getErrorMessage(caught, 'The manager did not say why.')),
      );
    } finally {
      clearTimeout(timer);
    }
  }, [name]);

  useEffect(() => {
    void reload();
    return () => {
      latest.current += 1;
      inFlight.current?.abort();
    };
  }, [reload, status]);

  return { catalog, failure, reload };
}
