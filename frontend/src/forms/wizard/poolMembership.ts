import { getJson } from '../../http';
import type { DeploymentGroup, Profile } from '../../types';

export async function readPoolMembership(signal: AbortSignal): Promise<{ groups: DeploymentGroup[]; profiles: Profile[] }> {
  const request = { cache: 'no-store' as const, signal };
  const [groups, profiles] = await Promise.all([
    getJson<{ groups: DeploymentGroup[] }>('/groups', request),
    getJson<{ profiles: Profile[] }>('/profiles', request),
  ]);
  if (!Array.isArray(groups?.groups) || !Array.isArray(profiles?.profiles)) throw new Error('Pool membership could not be checked');
  return { groups: groups.groups, profiles: profiles.profiles };
}
