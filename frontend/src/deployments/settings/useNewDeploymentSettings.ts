import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getErrorMessage, type NewDeploymentSettingsCatalog } from '@streaming-infra-manager/common';

import { ApiError } from '../../http';
import { fetchNewDeploymentSettings } from './deploymentSettingsApi';
import { type LoadFailure, loadFailureOf } from './settingsText';

const READ_TIMEOUT_MS = 15_000;

const TIMED_OUT = 'The manager did not answer in time. Try again.';

export interface NewDeploymentSettingsLoad {
  /** The list for the choices asked about now, or null while it is read, after a failure, or when nothing is asked. */
  catalog: NewDeploymentSettingsCatalog | null;
  /** Why the read for the choices asked about now failed, or null. */
  failure: LoadFailure | null;
  /** Reads the list for the same choices again. */
  reload: () => Promise<void>;
}

/** One answer, with the path it answers, so an answer about other choices is never taken for this one. */
interface Answer {
  path: string;
  catalog: NewDeploymentSettingsCatalog | null;
  failure: LoadFailure | null;
}

/**
 * The settings list a deployment the wizard has not created yet would start
 * with, read for `path` and again whenever it changes, which is whenever the
 * version, the services or the host change. Null asks for nothing. Only the
 * newest read's answer is kept, and a list read for other choices is never
 * answered for these, so what the wizard checks and sends matches what it
 * asked about.
 */
export function useNewDeploymentSettings(path: string | null): NewDeploymentSettingsLoad {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const latest = useRef(0);
  const inFlight = useRef<AbortController | null>(null);

  const read = useCallback(async (asked: string) => {
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
      const catalog = await fetchNewDeploymentSettings(asked, controller.signal);
      if (request === latest.current) setAnswer({ path: asked, catalog, failure: null });
    } catch (caught) {
      if (request !== latest.current) return;
      const failure =
        caught instanceof ApiError
          ? loadFailureOf(caught.code, caught.message)
          : loadFailureOf(null, timedOut ? TIMED_OUT : getErrorMessage(caught, 'The manager did not say why.'));
      setAnswer({ path: asked, catalog: null, failure });
    } finally {
      clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    if (path === null) return undefined;
    void read(path);
    return () => {
      latest.current += 1;
      inFlight.current?.abort();
    };
  }, [path, read]);

  const current = answer?.path === path ? answer : null;
  const reload = useCallback(async () => {
    if (path !== null) await read(path);
  }, [path, read]);

  return useMemo(
    () => ({ catalog: current?.catalog ?? null, failure: current?.failure ?? null, reload }),
    [current, reload],
  );
}
