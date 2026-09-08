import { engineOverviewIdentity, engineOverviewIdentityKey, type EngineOverviewIdentityInput } from '@streaming-infra-manager/common';

type OverviewProfile = Omit<EngineOverviewIdentityInput, 'stack_version_id'> & { stack_version_id?: number | null };

/** Legacy or malformed metadata cannot identify current observations. */
export function engineOverviewRequestKey(profile: OverviewProfile | null): string | null {
  const version = profile?.stack_version_id;
  if (!profile || typeof version !== 'number' || !Number.isSafeInteger(version) || version <= 0) return null;
  try {
    return engineOverviewIdentityKey(engineOverviewIdentity({ ...profile, stack_version_id: version }));
  } catch {
    return null;
  }
}
