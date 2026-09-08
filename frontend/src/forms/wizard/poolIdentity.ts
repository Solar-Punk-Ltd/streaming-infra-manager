import { ABR_LADDER_SIZE, ABR_RUNG_COMPONENTS, isLadderKind, ladderMemberNames } from '@streaming-infra-manager/common';
import type { DeploymentGroup, Profile } from '../../types';

export interface CreatedPool {
  group: DeploymentGroup;
  profiles: Profile[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPoolMember(value: unknown): value is Profile {
  if (!isRecord(value) || typeof value.name !== 'string' ||
      !['streamer', 'viewer', 'custom'].includes(value.kind as string) ||
      !['DEPLOYING', 'RUNNING', 'STOPPING', 'STOPPED', 'REMOVING', 'ERROR'].includes(value.status as string) ||
      typeof value.created_at !== 'string' || typeof value.updated_at !== 'string' ||
      (value.stamp_id != null && typeof value.stamp_id !== 'string') ||
      !Array.isArray(value.components) || value.components.length !== ABR_RUNG_COMPONENTS.length ||
      !ABR_RUNG_COMPONENTS.every(component => (value.components as unknown[]).includes(component)) ||
      !Array.isArray(value.containers)) return false;
  return value.containers.every(container => isRecord(container) && typeof container.service === 'string' &&
    isRecord(container.ports) && Object.values(container.ports).every(port => Number.isInteger(port) && Number(port) > 0 && Number(port) <= 65535));
}

/** Checks the identity and fields used by the pool selector and read-only node checklist. */
export function matchingPool(value: unknown, expectedName: string): CreatedPool | null {
  if (!isRecord(value) || !isRecord(value.group) || !Array.isArray(value.profiles)) return null;
  const { group, profiles } = value;
  if (!Number.isSafeInteger(group.id) || Number(group.id) <= 0 || !isLadderKind(group.kind as string) ||
      group.name !== expectedName || typeof group.created_at !== 'string' || group.size !== ABR_LADDER_SIZE ||
      profiles.length !== ABR_LADDER_SIZE) return null;
  const expected = new Set(ladderMemberNames(expectedName));
  for (const profile of profiles) {
    if (!isPoolMember(profile) || profile.group_id !== group.id || !expected.delete(profile.name)) return null;
  }
  return expected.size === 0 ? { group: group as unknown as DeploymentGroup, profiles } : null;
}
