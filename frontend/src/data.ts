import {
  defaultServicesFor,
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

export function canDeployUploader(profile: Profile): boolean {
  return (
    servicesNeedStamp(defaultServicesFor(profile)) &&
    hasStampId(profile) &&
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
