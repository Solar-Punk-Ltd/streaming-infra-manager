import { useCallback, useEffect, useState } from 'react';

import { getErrorMessage, type ManagerAdminLink } from '@streaming-infra-manager/common';

import { fetchManagerAdminLink } from './adminLinkApi';

export interface ManagerAdminLinkLoad {
  /** The link as last read, or null until the first answer. */
  link: ManagerAdminLink | null;
  /** Why the latest read failed, or null. */
  error: string | null;
  reload: () => Promise<void>;
  /** Takes a save's answer as the link, without another read. */
  replace: (link: ManagerAdminLink) => void;
}

/** The manager's own web2 admin link, read when the page opens. */
export function useManagerAdminLink(): ManagerAdminLinkLoad {
  const [link, setLink] = useState<ManagerAdminLink | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setLink(await fetchManagerAdminLink());
      setError(null);
    } catch (caught) {
      setError(getErrorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { link, error, reload, replace: setLink };
}
