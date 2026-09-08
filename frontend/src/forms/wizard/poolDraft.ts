import { ABR_LADDER_SIZE, ABR_RUNG_COMPONENTS, isLadderKind, ladderMemberNames } from '@streaming-infra-manager/common';
import type { DeploymentGroup, Profile } from '../../types';
import { initialWizardState, type WizardContext, type WizardState } from './wizardState';

export interface CreatedPool {
  group: DeploymentGroup;
  profiles: Profile[];
}

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

function matchesCreatedPool(result: CreatedPool & { expectedName: string }): boolean {
  const { group, profiles, expectedName } = result;
  if (!Number.isSafeInteger(group.id) || group.id <= 0 || !isLadderKind(group.kind) ||
      group.name !== expectedName || group.size !== ABR_LADDER_SIZE ||
      profiles.length !== ABR_LADDER_SIZE) return false;
  const expected = new Set(ladderMemberNames(group.name));
  for (const profile of profiles) {
    if (profile.group_id !== group.id || !expected.delete(profile.name) ||
        profile.components.length !== ABR_RUNG_COMPONENTS.length ||
        !ABR_RUNG_COMPONENTS.every(component => profile.components.includes(component))) return false;
  }
  return expected.size === 0;
}

export function finishPoolSetup(
  uploader: WizardState,
  result: (CreatedPool & { expectedName: string }) | null,
): { state: WizardState; created: CreatedPool | null; notice: string | null } {
  if (!result) return { state: uploader, created: null, notice: null };
  if (!matchesCreatedPool(result)) {
    return { state: uploader, created: null, notice: 'The manager accepted the request, but we could not select a matching storage pool from its response. Your uploader draft is unchanged. Check the pool before trying again.' };
  }
  return {
    state: { ...uploader, step: 3, poolMode: 'pick', poolId: result.group.id },
    created: { group: result.group, profiles: result.profiles },
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
