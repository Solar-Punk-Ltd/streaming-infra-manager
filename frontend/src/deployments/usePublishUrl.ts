import { useCallback, useEffect, useState } from 'react';

import { useDeployments } from '../app/useDeploymentsStore';
import { fetchSrtPassphrase } from '../data';
import { useServerHost } from '../ServerHostContext';
import type { Profile } from '../types';
import { srtPublishUrl } from '../urls';
import { publishPassphrase } from './publishPassphrase';

export interface PublishUrl {
  /**
   * The URL as this view can render it now. Without the passphrase until one
   * has been revealed, which is the whole URL for a deployment needing none.
   */
  url: string | null;
  /** Puts the whole URL on the clipboard, asking for the passphrase first. */
  copy: () => Promise<void>;
}

/** What one view has been told, and about which deployment. */
interface Revealed {
  name: string;
  passphrase: string | null;
}

/**
 * The URL a publisher points OBS at, and the passphrase that goes in it.
 *
 * The passphrase is not on the profile row, so it costs a request, and this is
 * where that request is made: for the one deployment on screen, when the
 * operator opens or copies its URL. What comes back is held in this
 * component's state and nowhere else. It is deliberately not merged into the
 * deployments store, because everything in that store is on every page for as
 * long as the tab is open, which is what taking the value off the row was for.
 *
 * @param shown whether this view puts the URL on screen, which is the operator
 *   opening it. A view that only offers a Copy button leaves it to the click,
 *   so a page of rows asks for no passphrase at all to render.
 */
export function usePublishUrl(profile: Profile, shown = false): PublishUrl {
  const { hostPassphrase } = useDeployments();
  const serverHost = useServerHost();
  const { name, has_srt_passphrase: holdsOwn } = profile;
  const [revealed, setRevealed] = useState<Revealed | null>(null);

  const readPassphrase = useCallback(async (): Promise<string | null> => {
    const passphrase = await publishPassphrase(
      { name, has_srt_passphrase: holdsOwn },
      hostPassphrase,
      fetchSrtPassphrase,
      // A reveal that fails leaves the operator the address without the
      // passphrase rather than nothing, and the next click asks again.
    ).catch(() => hostPassphrase);
    setRevealed({ name, passphrase });
    return passphrase;
  }, [hostPassphrase, holdsOwn, name]);

  useEffect(() => {
    if (shown) void readPassphrase();
  }, [readPassphrase, shown]);

  // Answered about another deployment is the same as not answered: this view
  // moved on before the hook was told again.
  const passphrase = revealed?.name === name ? revealed.passphrase : null;

  return {
    url: srtPublishUrl(profile, serverHost, passphrase),
    copy: async () => {
      const whole = srtPublishUrl(profile, serverHost, await readPassphrase());
      if (!whole) return;
      await navigator.clipboard.writeText(whole).catch(() => undefined);
    },
  };
}
