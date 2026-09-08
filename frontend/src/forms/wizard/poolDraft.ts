import { isLadderKind } from '@streaming-infra-manager/common';
import type { DeploymentGroup, Profile } from '../../types';
import { initialWizardState, type WizardContext, type WizardState } from './wizardState';
import { matchingPool, type CreatedPool } from './poolIdentity';
export type { CreatedPool } from './poolIdentity';

export type PoolSetupOutcome = { kind: 'cancelled' } | { kind: 'accepted'; expectedName: string; value: unknown };

export function beginPoolSetup(uploader: WizardState, context: WizardContext) {
  return {
    uploader: { ...uploader, components: [...uploader.components] },
    pool: {
      ...initialWizardState({ goal: 'abr-pool' }, context),
      host: uploader.host,
      hostCustom: uploader.hostCustom,
      versionId: uploader.versionId,
      components: [],
    },
  };
}

export function finishPoolSetup(
  uploader: WizardState,
  result: PoolSetupOutcome,
): { state: WizardState; created: CreatedPool | null; notice: string | null } {
  if (result.kind === 'cancelled') return { state: uploader, created: null, notice: null };
  const created = matchingPool(result.value, result.expectedName);
  if (!created) {
    return { state: uploader, created: null, notice: 'The manager accepted the request, but we could not select a matching storage pool from its response. Your uploader draft is unchanged. Check the pool before trying again.' };
  }
  return {
    state: { ...uploader, step: 3, poolMode: 'pick', poolId: created.group.id },
    created,
    notice: 'Storage pool created and selected. Your uploader is still a draft. Check each node’s funding and stamp before deploying the uploader.',
  };
}

/** Keep the accepted identity visible until the deployment store catches up. */
export function overlayCreatedPool(groups: DeploymentGroup[], profiles: Profile[], created: CreatedPool | null) {
  if (!created) return { groups, profiles };
  const currentGroup = groups.find(group => group.id === created.group.id);
  if (currentGroup && (currentGroup.name !== created.group.name || !isLadderKind(currentGroup.kind))) return { groups, profiles };
  const currentNames = new Set(profiles.map(profile => profile.name));
  return {
    groups: currentGroup ? groups : [...groups, created.group],
    profiles: [...profiles, ...created.profiles.filter(profile => !currentNames.has(profile.name))],
  };
}
