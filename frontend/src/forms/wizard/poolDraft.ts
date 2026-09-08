import type { DeploymentGroup, Profile } from '../../types';
import { initialWizardState, type WizardContext, type WizardState } from './wizardState';
import { matchingPool, type CreatedPool } from './poolIdentity';
export type { CreatedPool } from './poolIdentity';
import { POOL_RESPONSE_NOTICE } from './PoolResponseError';

export type PoolSetupOutcome = { kind: 'cancelled' } | { kind: 'accepted'; expectedName: string; value: unknown };

export function beginPoolSetup(uploader: WizardState, context: WizardContext): { uploader: WizardState; pool: WizardState } {
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
    return { state: uploader, created: null, notice: POOL_RESPONSE_NOTICE };
  }
  return {
    state: { ...uploader, step: 3, poolMode: 'pick', poolId: created.group.id },
    created,
    notice: 'Storage pool created and selected. Your uploader is still a draft. Check each node’s funding and stamp before deploying the uploader.',
  };
}

/** Keep the accepted identity visible until the deployment store catches up. */
export function overlayCreatedPool(groups: DeploymentGroup[], profiles: Profile[], created: CreatedPool | null) {
  const authoritative = { groups, profiles, created: null };
  if (!created) return authoritative;
  const currentGroup = groups.find(group => group.id === created.group.id);
  if (currentGroup && (currentGroup.name !== created.group.name || currentGroup.kind !== created.group.kind ||
      currentGroup.size !== created.group.size)) return authoritative;
  const currentNames = new Set(profiles.map(profile => profile.name));
  const projected = {
    groups: currentGroup ? groups : [...groups, created.group],
    profiles: [...profiles, ...created.profiles.filter(profile => !currentNames.has(profile.name))],
  };
  const projectedMembers = projected.profiles.filter(profile => profile.group_id === created.group.id);
  if (!matchingPool({ group: currentGroup ?? created.group, profiles: projectedMembers }, created.group.name)) return authoritative;
  if (currentGroup && matchingPool({ group: currentGroup, profiles: profiles.filter(profile => profile.group_id === created.group.id) }, created.group.name)) return authoritative;
  return { ...projected, created };
}
