import { useCallback, useEffect, useMemo, useState } from 'react';

import type { DeployAttemptView } from '@streaming-infra-manager/common';

import { useToast } from '../app/ToastProvider';
import { useDeployments } from '../app/useDeploymentsStore';

const RESOLVED_MEANWHILE =
  'That attempt was resolved or released meanwhile. There is nothing to release.';

export interface AttemptRelease {
  /** The attempt the dialog is open on, read from the live list, or null. */
  releasing: DeployAttemptView | null;
  open: (attempt: DeployAttemptView) => void;
  close: () => void;
  released: (released: DeployAttemptView) => void;
  /** The manager said the attempt is not there any more. */
  gone: () => void;
}

/**
 * The release dialog's state for a page: which attempt it is open on, by id,
 * so what it shows is the attempt as the store last read it and never a
 * copy taken at the click. An attempt resolved or released elsewhere while
 * the dialog is open drops out of the list, and the dialog closes with a
 * word rather than offering a release of something that is gone.
 */
export function useAttemptRelease(): AttemptRelease {
  const { attempts, reloadAttempts } = useDeployments();
  const toast = useToast();
  const [releasingId, setReleasingId] = useState<number | null>(null);
  const releasing = useMemo(
    () => attempts.find((attempt) => attempt.id === releasingId) ?? null,
    [attempts, releasingId],
  );

  useEffect(() => {
    if (releasingId === null || releasing !== null) return;
    setReleasingId(null);
    toast(RESOLVED_MEANWHILE, 'info');
  }, [releasingId, releasing, toast]);

  const close = useCallback(() => setReleasingId(null), []);
  const open = useCallback((attempt: DeployAttemptView) => setReleasingId(attempt.id), []);
  const released = useCallback(
    (done: DeployAttemptView) => {
      toast(`Released ${done.jobId}. ${done.project} can be deployed again.`, 'success');
      reloadAttempts();
    },
    [toast, reloadAttempts],
  );
  const gone = useCallback(() => {
    setReleasingId(null);
    toast(RESOLVED_MEANWHILE, 'info');
    reloadAttempts();
  }, [toast, reloadAttempts]);

  return { releasing, open, close, released, gone };
}
