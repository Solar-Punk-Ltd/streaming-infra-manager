import {
  type BeePublishersResult,
  DEFAULT_CHEQUEBOOK_FLOOR_BZZ,
  defaultServicesFor,
  hasBeePublishers,
  hasStampId,
  servicesNeedStamp,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

import { apiFetch, failWith, getJson, send, sendJson } from './http';
import type {
  CreateProfileBody,
  DeploymentGroup,
  Profile,
  ProfileKind,
} from './types';

export interface ServerConfig {
  host: string;
  srtPassphrase: string | null;
  /**
   * BZZ a node's chequebook must hold before this manager will start its
   * uploader. Read from the manager so the number shown is the one it refuses
   * on, rather than a copy that can drift.
   */
  chequebookFloorBzz: string;
}

/** What every group write answers with: the group and its members. */
export interface GroupWithMembers {
  group: DeploymentGroup;
  profiles: Profile[];
}

export async function fetchServerConfig(): Promise<ServerConfig> {
  try {
    const body = await getJson<{
      host: string;
      srtPassphrase?: string | null;
      chequebookFloorBzz?: string;
    }>('/config');
    return {
      host: body.host,
      srtPassphrase: body.srtPassphrase ?? null,
      chequebookFloorBzz:
        body.chequebookFloorBzz ?? DEFAULT_CHEQUEBOOK_FLOOR_BZZ,
    };
  } catch {
    return {
      host: window.location.hostname,
      srtPassphrase: null,
      chequebookFloorBzz: DEFAULT_CHEQUEBOOK_FLOOR_BZZ,
    };
  }
}

export async function fetchProfiles(): Promise<Profile[]> {
  const body = await getJson<{ profiles: Profile[] }>('/profiles');
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

function postAction(name: string, action: ProfileAction): Promise<void> {
  return send('POST', `/profiles/${encodeURIComponent(name)}/${action}`, {});
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

export function deleteProfile(name: string): Promise<void> {
  return send('DELETE', `/profiles/${encodeURIComponent(name)}`);
}

export function createProfile(body: CreateProfileBody): Promise<Profile> {
  return sendJson<Profile>('POST', '/profiles', body);
}

export type UpdateProfileBody = Omit<CreateProfileBody, 'name' | 'host'> & {
  /** The revision the drawer loaded the notes at, sent along with an edited note. */
  notes_revision?: number;
};

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
  srt_passphrase?: string;
  /** The stack version every member runs. Absent means the manager's default one. */
  stack_version_id?: number;
}

export function createDeploymentGroup(
  body: CreateGroupBody,
): Promise<GroupWithMembers> {
  return sendJson<GroupWithMembers>('POST', '/groups', body);
}

export interface UpdateGroupConfigBody {
  notes?: string | null;
  feed_owner?: string;
  feed_topic?: string;
  stamp_id?: string;
  /**
   * `null` puts the group back on the host-wide passphrase.
   *
   * The PATCH reads `undefined` as "leave it alone", so sending `undefined` for
   * the host-passphrase choice meant a group that had once been given its own
   * could never be moved off it. Only an explicit null clears the column.
   */
  srt_passphrase?: string | null;
}

export function updateGroupConfig(
  id: number,
  body: UpdateGroupConfigBody,
): Promise<GroupWithMembers> {
  return sendJson<GroupWithMembers>('PATCH', `/groups/${id}/config`, body);
}

export function addGroupMembers(
  id: number,
  count: number,
): Promise<GroupWithMembers> {
  return sendJson<GroupWithMembers>('POST', `/groups/${id}/members`, { count });
}

// Re-exported rather than redeclared: these are the manager's response shape, and
// a local copy silently loses whatever the server adds. It already had: the
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
  const res = await apiFetch(`/groups/${groupId}/bee-publishers`);
  if (res.status === 409) return null;
  if (!res.ok) await failWith(res, `request failed (${res.status})`);
  return (await res.json()) as BeePublishersResult;
}

export async function fetchGroups(): Promise<DeploymentGroup[]> {
  try {
    return (await getJson<{ groups: DeploymentGroup[] }>('/groups')).groups;
  } catch {
    return [];
  }
}

export function updateProfile(
  name: string,
  body: UpdateProfileBody,
): Promise<Profile> {
  return sendJson<Profile>(
    'PUT',
    `/profiles/${encodeURIComponent(name)}`,
    body,
  );
}

/**
 * Saves the notes alone: no claim on the deployment, no deploy. A note saved
 * elsewhere since `loadedRevision` was read is answered with 409.
 */
export function updateNotes(
  name: string,
  notes: string | null,
  loadedRevision: number,
): Promise<Profile> {
  return sendJson<Profile>(
    'PATCH',
    `/profiles/${encodeURIComponent(name)}/notes`,
    { notes, notes_revision: loadedRevision },
  );
}
