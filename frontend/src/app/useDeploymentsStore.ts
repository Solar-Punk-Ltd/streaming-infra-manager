import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import { getErrorMessage } from '@streaming-infra-manager/common';

import type { Tone } from '../components/tone';
import { fetchGroups, fetchProfiles, fetchServerConfig } from '../data';
import type { DeploymentGroup, Profile } from '../types';

export interface ActivityEntry {
  id: number;
  time: string;
  text: string;
  tone: Tone;
}

export interface DeploymentsStore {
  profiles: Profile[] | null;
  groups: DeploymentGroup[];
  /** The host the manager publishes its deployments on. */
  serverHost: string;
  /** The host-wide SRT passphrase, or null when the host has none. */
  hostPassphrase: string | null;
  /** The /events stream is open, so what is on screen is live. */
  connected: boolean;
  activity: ActivityEntry[];
  loadError: string | null;
  reload: () => void;
  /** Folds freshly created profiles in without waiting for their events. */
  mergeProfiles: (profiles: Profile[]) => void;
}

const DeploymentsContext = createContext<DeploymentsStore | null>(null);

export const DeploymentsProvider = DeploymentsContext.Provider;

export function useDeployments(): DeploymentsStore {
  const store = useContext(DeploymentsContext);
  if (!store) {
    throw new Error('useDeployments must be used inside DeploymentsProvider');
  }
  return store;
}

const ACTIVITY_LIMIT = 8;

const ACTIVITY_TEXT: Record<string, { suffix: string; tone: Tone }> = {
  RUNNING: { suffix: 'is running', tone: 'ok' },
  STOPPED: { suffix: 'stopped', tone: 'gray' },
  ERROR: { suffix: 'failed to deploy', tone: 'err' },
};

function nowTime(): string {
  return new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Everything the pages read: the profiles, their groups, the host config, and a
 * live feed of changes.
 *
 * The `/events` stream is the only thing that keeps a status current, so its
 * open flag is surfaced as `connected` and shown in the top bar. A screen that
 * has quietly stopped updating looks exactly like one where nothing is
 * happening, which is the worst way to read a deploy.
 */
export function useDeploymentsStore(): DeploymentsStore {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [groups, setGroups] = useState<DeploymentGroup[]>([]);
  const [serverHost, setServerHost] = useState(window.location.hostname);
  const [hostPassphrase, setHostPassphrase] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const nextActivityId = useRef(0);

  const reload = useCallback(() => {
    fetchProfiles()
      .then((next) => {
        setProfiles(next);
        setLoadError(null);
      })
      .catch((error: unknown) => setLoadError(getErrorMessage(error)));
    fetchGroups().then(setGroups).catch(() => undefined);
  }, []);

  const mergeProfiles = useCallback((incoming: Profile[]) => {
    setProfiles((prev) => {
      const merged = [...incoming, ...(prev ?? [])];
      const seen = new Set<string>();
      return merged.filter((p) => {
        if (seen.has(p.name)) return false;
        seen.add(p.name);
        return true;
      });
    });
    fetchGroups().then(setGroups).catch(() => undefined);
  }, []);

  const log = useCallback((text: string, tone: Tone) => {
    setActivity((prev) =>
      [
        { id: nextActivityId.current++, time: nowTime(), text, tone },
        ...prev,
      ].slice(0, ACTIVITY_LIMIT),
    );
  }, []);

  useEffect(() => reload(), [reload]);

  useEffect(() => {
    fetchServerConfig()
      .then((config) => {
        setServerHost(config.host);
        setHostPassphrase(config.srtPassphrase);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const source = new EventSource('/events');
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    source.addEventListener('profile.changed', (event: MessageEvent<string>) => {
      const { profile } = JSON.parse(event.data) as { profile: Profile };
      setProfiles((prev) => {
        if (!prev) return [profile];
        const index = prev.findIndex((p) => p.name === profile.name);
        if (index === -1) return [profile, ...prev];
        const copy = prev.slice();
        copy[index] = profile;
        return copy;
      });
      const entry = ACTIVITY_TEXT[profile.status];
      if (entry) log(`${profile.name} ${entry.suffix}`, entry.tone);
    });

    source.addEventListener('profile.deleted', (event: MessageEvent<string>) => {
      const { name } = JSON.parse(event.data) as { name: string };
      setProfiles((prev) => (prev ? prev.filter((p) => p.name !== name) : prev));
      log(`${name} removed`, 'gray');
      fetchGroups().then(setGroups).catch(() => undefined);
    });

    return () => source.close();
  }, [log]);

  return {
    profiles,
    groups,
    serverHost,
    hostPassphrase,
    connected,
    activity,
    loadError,
    reload,
    mergeProfiles,
  };
}
