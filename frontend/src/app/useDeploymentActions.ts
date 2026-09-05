import { createContext, useCallback, useContext, useState } from 'react';

import { getErrorMessage } from '@streaming-infra-manager/common';

import type { ConfirmRequest } from '../components/ConfirmDialog';
import {
  addGroupMembers,
  deleteProfile,
  deployProfile,
  deployUploader,
  stopProfile,
} from '../data';
import type { DeploymentGroup, Profile } from '../types';
import { hostFor } from '../urls';
import { isRunning, isTransitional } from '../deployments/shape';
import { useToast } from './ToastProvider';
import { useDeployments } from './useDeploymentsStore';

export interface DeploymentActions {
  isBusy: (name: string) => boolean;
  start: (name: string) => void;
  stop: (name: string) => void;
  startUploader: (name: string) => void;
  requestRemove: (profile: Profile) => void;
  startGroup: (group: DeploymentGroup, members: Profile[]) => void;
  stopGroup: (group: DeploymentGroup, members: Profile[]) => void;
  requestRemoveGroup: (group: DeploymentGroup, members: Profile[]) => void;
  addMembers: (group: DeploymentGroup, count: number) => Promise<void>;
  confirm: ConfirmRequest | null;
  closeConfirm: () => void;
}

const ActionsContext = createContext<DeploymentActions | null>(null);

export const ActionsProvider = ActionsContext.Provider;

export function useActions(): DeploymentActions {
  const actions = useContext(ActionsContext);
  if (!actions) {
    throw new Error('useActions must be used inside ActionsProvider');
  }
  return actions;
}

/**
 * Every write the pages can make, with one busy set and one place that decides
 * what a failure says.
 *
 * The two removals go through `confirm` rather than firing: they wipe the data
 * directory on the host, and the manager offers no way back.
 */
export function useDeploymentActions(): DeploymentActions {
  const { serverHost, reload } = useDeployments();
  const toast = useToast();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const withBusy = useCallback(
    async (names: string[], run: () => Promise<void>) => {
      setBusy((prev) => new Set([...prev, ...names]));
      try {
        await run();
      } finally {
        setBusy((prev) => new Set([...prev].filter((n) => !names.includes(n))));
      }
    },
    [],
  );

  const runOne = useCallback(
    (name: string, verb: string, call: (name: string) => Promise<void>) => {
      void withBusy([name], async () => {
        try {
          await call(name);
          toast(`${verb} ${name}`, 'success');
        } catch (error) {
          toast(`${verb} ${name} failed. ${getErrorMessage(error)}`, 'error');
        }
      });
    },
    [toast, withBusy],
  );

  const runMany = useCallback(
    (names: string[], verb: string, call: (name: string) => Promise<void>) => {
      if (names.length === 0) return;
      void withBusy(names, async () => {
        const results = await Promise.allSettled(names.map(call));
        const failed = names.filter(
          (_name, index) => results[index].status === 'rejected',
        );
        if (failed.length === 0) {
          toast(`${verb} ${names.length} deployments`, 'success');
          return;
        }
        const first = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        );
        toast(
          `${verb} failed for ${failed.join(', ')}. ${getErrorMessage(first?.reason)}`,
          'error',
        );
      });
    },
    [toast, withBusy],
  );

  const start = useCallback(
    (name: string) => runOne(name, 'Starting', deployProfile),
    [runOne],
  );

  const stop = useCallback(
    (name: string) => runOne(name, 'Stopping', stopProfile),
    [runOne],
  );

  const startUploader = useCallback(
    (name: string) => runOne(name, 'Starting the uploader for', deployUploader),
    [runOne],
  );

  const requestRemove = useCallback(
    (profile: Profile) => {
      setConfirm({
        title: `Remove ${profile.name}?`,
        body: `This stops the containers, deletes the record and wipes the deployment's data directory on ${hostFor(profile, serverHost)}. This cannot be undone.`,
        confirmLabel: 'Remove',
        danger: true,
        onConfirm: () => runOne(profile.name, 'Removing', deleteProfile),
      });
    },
    [runOne, serverHost],
  );

  const startGroup = useCallback(
    (group: DeploymentGroup, members: Profile[]) => {
      const names = members
        .filter((m) => !isRunning(m) && !isTransitional(m))
        .map((m) => m.name);
      runMany(names, `Starting ${group.name}:`, deployProfile);
    },
    [runMany],
  );

  const stopGroup = useCallback(
    (group: DeploymentGroup, members: Profile[]) => {
      const names = members.filter(isRunning).map((m) => m.name);
      runMany(names, `Stopping ${group.name}:`, stopProfile);
    },
    [runMany],
  );

  const requestRemoveGroup = useCallback(
    (group: DeploymentGroup, members: Profile[]) => {
      setConfirm({
        title: `Remove group ${group.name}?`,
        body: `All ${members.length} members are stopped and removed, and their data directories are wiped. This cannot be undone.`,
        confirmLabel: 'Remove group',
        danger: true,
        onConfirm: () =>
          runMany(
            members.map((m) => m.name),
            `Removing ${group.name}:`,
            deleteProfile,
          ),
      });
    },
    [runMany],
  );

  const addMembers = useCallback(
    async (group: DeploymentGroup, count: number) => {
      try {
        const result = await addGroupMembers(group.id, count);
        toast(
          `Added ${result.profiles.length} to ${group.name}, deploying now`,
          'success',
        );
        reload();
      } catch (error) {
        toast(`Could not add members. ${getErrorMessage(error)}`, 'error');
      }
    },
    [reload, toast],
  );

  const isBusy = useCallback((name: string) => busy.has(name), [busy]);

  return {
    isBusy,
    start,
    stop,
    startUploader,
    requestRemove,
    startGroup,
    stopGroup,
    requestRemoveGroup,
    addMembers,
    confirm,
    closeConfirm: () => setConfirm(null),
  };
}
