import {
  type BeePublishersResult,
  defaultServicesFor,
  hasBeePublishers,
  hasStampId,
  servicesNeedStamp,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

import { extractApiError } from './http';
import type {
  CreateProfileBody,
  DeploymentGroup,
  Profile,
  ProfileKind,
} from './types';

export { hasStampId } from '@streaming-infra-manager/common';

export interface ServerConfig {
  host: string;
  srtPassphrase: string | null;
}

export async function fetchServerConfig(): Promise<ServerConfig> {
  try {
    const res = await fetch('/config');
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as {
      host: string;
      srtPassphrase?: string | null;
    };
    return { host: body.host, srtPassphrase: body.srtPassphrase ?? null };
  } catch {
    return { host: window.location.hostname, srtPassphrase: null };
  }
}

export async function fetchProfiles(): Promise<Profile[]> {
  const res = await fetch('/profiles');
  if (!res.ok) throw new Error(`fetch profiles failed (${res.status})`);
  const body = (await res.json()) as { profiles: Profile[] };
  return body.profiles;
}

function uploaderDeployed(profile: Profile): boolean {
  return profile.containers.some(
    (c) => c.service === STREAM_UPLOADER_SERVICE,
  );
}

// A pool-backed uploader carries the pool's batches in BEE_PUBLISHERS, so it
// needs no stamp of its own to be deployable.
export function canDeployUploader(profile: Profile): boolean {
  return (
    servicesNeedStamp(defaultServicesFor(profile)) &&
    (hasStampId(profile) || hasBeePublishers(profile)) &&
    !uploaderDeployed(profile)
  );
}

type ProfileAction = 'deploy' | 'stop' | 'deploy-uploader';

async function postAction(name: string, action: ProfileAction): Promise<void> {
  const res = await fetch(`/profiles/${encodeURIComponent(name)}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    throw new Error(
      await extractApiError(res, `${action} failed (${res.status})`),
    );
  }

  await res.text().catch(() => undefined);
}

export function deployProfile(name: string): Promise<void> {
  return postAction(name, 'deploy');
}

export function stopProfile(name: string): Promise<void> {
  return postAction(name, 'stop');
}

export function deployUploader(name: string): Promise<void> {
  return postAction(name, 'deploy-uploader');
}

export async function deleteProfile(name: string): Promise<void> {
  const res = await fetch(`/profiles/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error(await extractApiError(res, `delete failed (${res.status})`));
  }
}

export async function createProfile(body: CreateProfileBody): Promise<Profile> {
  const res = await fetch('/profiles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      await extractApiError(res, `request failed (${res.status})`),
    );
  }
  return (await res.json()) as Profile;
}

export type UpdateProfileBody = Omit<CreateProfileBody, 'name' | 'host'>;

export interface CreateGroupBody {
  group_name: string;
  size: number;
  /** One bee-uploader per ABR rung, named `<group>-<rung>`. Fixes size + components. */
  abr_ladder?: boolean;
  kind: ProfileKind;
  notes?: string | null;
  host?: string;
  components?: string[];
  feed_owner?: string;
  private_key?: string;
  public_key?: string;
  stamp_id?: string;
}

export async function createDeploymentGroup(
  body: CreateGroupBody,
): Promise<{ group: DeploymentGroup; profiles: Profile[] }> {
  const res = await fetch('/groups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      await extractApiError(res, `request failed (${res.status})`),
    );
  }
  return (await res.json()) as { group: DeploymentGroup; profiles: Profile[] };
}

export interface UpdateGroupConfigBody {
  notes?: string | null;
  feed_owner?: string;
  feed_topic?: string;
  stamp_id?: string;
}

export async function updateGroupConfig(
  id: number,
  body: UpdateGroupConfigBody,
): Promise<{ group: DeploymentGroup; profiles: Profile[] }> {
  const res = await fetch(`/groups/${id}/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      await extractApiError(res, `request failed (${res.status})`),
    );
  }
  return (await res.json()) as { group: DeploymentGroup; profiles: Profile[] };
}

export async function addGroupMembers(
  id: number,
  count: number,
): Promise<{ group: DeploymentGroup; profiles: Profile[] }> {
  const res = await fetch(`/groups/${id}/members`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ count }),
  });
  if (!res.ok) {
    throw new Error(
      await extractApiError(res, `request failed (${res.status})`),
    );
  }
  return (await res.json()) as { group: DeploymentGroup; profiles: Profile[] };
}

// Re-exported rather than redeclared: these are the manager's response shape, and
// a local copy silently loses whatever the server adds. It already had — the
// per-rung verification fields were arriving in the JSON and were invisible to the
// compiler, so nothing would have caught a rename.
export type {
  BeePublishersResult,
  LadderRungState,
  RungNote,
} from '@streaming-infra-manager/common';

/**
 * The assembled BEE_PUBLISHERS for a ladder group, or which rungs are holding it
 * up. Returns null for a group that is not a ladder, so callers can probe cheaply
 * without knowing in advance.
 */
export async function fetchBeePublishers(
  groupId: number,
): Promise<BeePublishersResult | null> {
  const res = await fetch(`/groups/${groupId}/bee-publishers`);
  if (res.status === 409) return null;
  if (!res.ok) {
    throw new Error(
      await extractApiError(res, `request failed (${res.status})`),
    );
  }
  return (await res.json()) as BeePublishersResult;
}

export async function fetchGroups(): Promise<DeploymentGroup[]> {
  try {
    const res = await fetch('/groups');
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { groups: DeploymentGroup[] };
    return body.groups;
  } catch {
    return [];
  }
}

export async function updateProfile(
  name: string,
  body: UpdateProfileBody,
): Promise<Profile> {
  const res = await fetch(`/profiles/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      await extractApiError(res, `request failed (${res.status})`),
    );
  }
  return (await res.json()) as Profile;
}
