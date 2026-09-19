import { useCallback, useEffect, useRef, useState } from 'react';

import { OME_SERVICE } from '@streaming-infra-manager/common';

import { useDeployments } from '../app/useDeploymentsStore';
import { fetchSrtPassphrase } from '../data';
import { useServerHost } from '../ServerHostContext';
import type { Profile } from '../types';
import { srtPublishUrl } from '../urls';
import { publishPassphrase } from './publishPassphrase';
import { engineOf } from './shape';

export interface PublishUrl {
  /**
   * The URL as this view can render it now. Without the passphrase until one
   * has been revealed, which is the whole URL for a deployment needing none.
   */
  url: string | null;
  /** Whether this revision still needs its own passphrase before it is complete. */
  pending: boolean;
  /** Puts the whole URL on the clipboard, asking for the passphrase first. */
  copy: () => Promise<void>;
}

/** Whether this engine's publish URL needs a per-deployment reveal. */
export function publishUrlNeedsReveal(profile: Profile): boolean {
  return profile.has_srt_passphrase && engineOf(profile) !== OME_SERVICE;
}

/** What one view has been told, and about which deployment. */
interface Revealed {
  generation: number;
  passphrase: string | null;
}

interface RevealInputs {
  name: string;
  profileRevision: string;
  holdsOwn: boolean;
  hostPassphrase: string | null;
  serverHost: string;
}

function sameInputs(left: RevealInputs, right: RevealInputs): boolean {
  return left.name === right.name &&
    left.profileRevision === right.profileRevision &&
    left.holdsOwn === right.holdsOwn &&
    left.hostPassphrase === right.hostPassphrase &&
    left.serverHost === right.serverHost;
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
  const inputs: RevealInputs = {
    name,
    profileRevision: `${profile.instance_id}:${profile.intent_revision}:${profile.updated_at}`,
    holdsOwn,
    hostPassphrase,
    serverHost,
  };
  const currentInputs = useRef(inputs);
  const requestGeneration = useRef(0);
  if (!sameInputs(currentInputs.current, inputs)) {
    currentInputs.current = inputs;
    requestGeneration.current += 1;
  }
  const generation = requestGeneration.current;
  const [revealed, setRevealed] = useState<Revealed | null>(null);

  const readPassphrase = useCallback(async (): Promise<Revealed | null> => {
    const passphrase = await publishPassphrase(
      { name, has_srt_passphrase: holdsOwn },
      hostPassphrase,
      fetchSrtPassphrase,
      // A reveal that fails leaves the operator the address without the
      // passphrase rather than nothing, and the next click asks again.
    ).catch(() => hostPassphrase);
    if (requestGeneration.current !== generation) return null;
    const answer = { generation, passphrase };
    setRevealed(answer);
    return answer;
  }, [generation, hostPassphrase, holdsOwn, name]);

  useEffect(() => {
    if (shown) void readPassphrase();
  }, [readPassphrase, shown]);

  // A profile revision may rotate its own passphrase while keeping the same
  // name and the same `has_srt_passphrase` flag. Until that revision's reveal
  // answers, no URL or copy action may retain the earlier secret.
  const passphrase = revealed?.generation === generation ? revealed.passphrase : null;

  return {
    url: srtPublishUrl(profile, serverHost, passphrase),
    pending: publishUrlNeedsReveal(profile) && revealed?.generation !== generation,
    copy: async () => {
      const answer = await readPassphrase();
      if (!answer) return;
      const whole = srtPublishUrl(profile, serverHost, answer.passphrase);
      if (!whole) return;
      await navigator.clipboard.writeText(whole).catch(() => undefined);
    },
  };
}
