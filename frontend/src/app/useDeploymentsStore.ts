import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  DEFAULT_CHEQUEBOOK_FLOOR_BZZ,
  getErrorMessage,
  reconcileProfiles,
  type DeployAttemptView,
  type StackVersion,
} from '@streaming-infra-manager/common';

import type { Tone } from '../components/tone';
import { fetchGroups, fetchProfiles, fetchServerConfig } from '../data';
import { openLiveStream } from '../liveStream';
import type { DeploymentGroup, Profile } from '../types';
import { useToast, type ToastTone } from './ToastProvider';
import { fetchAttempts } from '../versions/attemptsApi';
import { fetchVersions } from '../versions/versionsApi';

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
  /** The chequebook floor the manager's uploader gate refuses below. */
  chequebookFloorBzz: string;
  /** The /events stream is open, so what is on screen is live. */
  connected: boolean;
  activity: ActivityEntry[];
  loadError: string | null;
  /** The stack versions this manager holds. Null until the first answer. */
  versions: StackVersion[] | null;
  versionsError: string | null;
  /**
   * The deploy attempts still holding a deployment or the host. Empty until
   * the first answer, because a page has nothing to say about an attempt it
   * has not read.
   */
  attempts: DeployAttemptView[];
  attemptsError: string | null;
  reload: () => void;
  reloadVersions: () => void;
  reloadAttempts: () => void;
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

/**
 * A notice the manager sent about a deployment, in the shape the SSE frame
 * carries it. `profile` is the name it happened to.
 */
interface ProfileNotice {
  profile: string;
  text: string;
  tone: Tone;
}

const NOTICE_TOAST: Record<string, ToastTone> = {
  info: 'info',
  warn: 'warning',
  err: 'error',
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
 * happening, which is the worst way to read a deploy. Reconnecting refetches
 * for the same reason: the stream has no backlog to replay.
 */
export function useDeploymentsStore(): DeploymentsStore {
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [groups, setGroups] = useState<DeploymentGroup[]>([]);
  const [serverHost, setServerHost] = useState(window.location.hostname);
  const [hostPassphrase, setHostPassphrase] = useState<string | null>(null);
  const [chequebookFloorBzz, setChequebookFloorBzz] = useState(
    DEFAULT_CHEQUEBOOK_FLOOR_BZZ,
  );
  const [connected, setConnected] = useState(false);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [versions, setVersions] = useState<StackVersion[] | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<DeployAttemptView[]>([]);
  const [attemptsError, setAttemptsError] = useState<string | null>(null);
  const nextActivityId = useRef(0);
  const hasOpened = useRef(false);
  const toast = useToast();

  const reload = useCallback(() => {
    const fetchStartedAt = Date.now();
    fetchProfiles()
      .then((next) => {
        setProfiles((previous) =>
          previous ? reconcileProfiles(previous, next, fetchStartedAt) : next,
        );
        setLoadError(null);
      })
      .catch((error: unknown) => setLoadError(getErrorMessage(error)));
    fetchGroups().then(setGroups).catch(() => undefined);
  }, []);

  const reloadVersions = useCallback(() => {
    fetchVersions()
      .then((next) => {
        setVersions(next);
        setVersionsError(null);
      })
      .catch((error: unknown) => setVersionsError(getErrorMessage(error)));
  }, []);

  const reloadAttempts = useCallback(() => {
    fetchAttempts()
      .then((next) => {
        setAttempts(next);
        setAttemptsError(null);
      })
      .catch((error: unknown) => setAttemptsError(getErrorMessage(error)));
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
  useEffect(() => reloadVersions(), [reloadVersions]);
  useEffect(() => reloadAttempts(), [reloadAttempts]);

  useEffect(() => {
    fetchServerConfig()
      .then((config) => {
        setServerHost(config.host);
        setHostPassphrase(config.srtPassphrase);
        setChequebookFloorBzz(config.chequebookFloorBzz);
      })
      .catch(() => undefined);
  }, []);

  useEffect(
    () =>
      openLiveStream('/events', {
        onOpen: () => {
          setConnected(true);
          // The stream carries no backlog, so a deployment that stopped, failed
          // or was removed while it was down is only in the database.
          if (hasOpened.current) {
            reload();
            reloadAttempts();
          }
          hasOpened.current = true;
        },
        onDown: () => setConnected(false),
        events: {
          'profile.changed': (event: MessageEvent<string>) => {
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
          },

          // Something the manager did that changed nothing about the
          // deployment, so no other event would carry it: it goes to the
          // activity feed and to a toast, because a deploy the operator is
          // watching is where it matters.
          'profile.notice': (event: MessageEvent<string>) => {
            const notice = JSON.parse(event.data) as ProfileNotice;
            log(notice.text, notice.tone);
            toast(notice.text, NOTICE_TOAST[notice.tone] ?? 'info');
          },

          'profile.deleted': (event: MessageEvent<string>) => {
            const { name } = JSON.parse(event.data) as { name: string };
            setProfiles((prev) =>
              prev ? prev.filter((p) => p.name !== name) : prev,
            );
            log(`${name} removed`, 'gray');
            fetchGroups().then(setGroups).catch(() => undefined);
          },

          'engine.restarted': (event: MessageEvent<string>) => {
            const { profile, service } = JSON.parse(event.data) as {
              profile: string;
              service: string;
            };
            log(`${service} restarted on ${profile}`, 'info');
          },

          // No payload: the default badge, every usage count and a build's
          // status move together, so the whole table is read again.
          'version.changed': () => reloadVersions(),

          // No payload either: an attempt opened, resolved or released, and
          // what holds the host is read whole.
          'attempt.changed': () => reloadAttempts(),
        },
      }),
    [log, reload, toast, reloadVersions, reloadAttempts],
  );

  // A fresh object every render is a fresh context value, and every consumer
  // of the store renders again for it. A version.changed event reloads the
  // whole versions table, so without this each of those redrew the deployments
  // list, the host page and the metrics too.
  return useMemo(
    () => ({
      profiles,
      groups,
      serverHost,
      hostPassphrase,
      chequebookFloorBzz,
      connected,
      activity,
      loadError,
      versions,
      versionsError,
      attempts,
      attemptsError,
      reload,
      reloadVersions,
      reloadAttempts,
      mergeProfiles,
    }),
    [
      profiles,
      groups,
      serverHost,
      hostPassphrase,
      chequebookFloorBzz,
      connected,
      activity,
      loadError,
      versions,
      versionsError,
      attempts,
      attemptsError,
      reload,
      reloadVersions,
      reloadAttempts,
      mergeProfiles,
    ],
  );
}
