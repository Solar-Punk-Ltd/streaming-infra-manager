import {
  type BeePublishersResult,
  type ConfiguredBeeRpcEndpoint,
  DEFAULT_CHEQUEBOOK_FLOOR_BZZ,
  defaultServicesFor,
  type EngineSettings,
  hasBeePublishers,
  hasStampId,
  type NodeMode,
  type RpcEndpointSource,
  servicesNeedStamp,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

import { ACTION_TIMEOUT_MS, actionTimedOutMessage } from './deployments/actionLimit';
import {
  apiFetch,
  checkSessionAfterStreamClosed,
  failWith,
  getJson,
  isTimeout,
  send,
  sendJson,
} from './http';
import { readScriptOutcome, ScriptStreamEndedError } from './scriptStream';
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
  /**
   * The chain endpoint this manager is configured with, for the nodes it
   * creates. Its host and never its URL: an endpoint can carry an API key in
   * its path or its user info, and this answer reaches every signed-in page.
   */
  beeRpcEndpoint: ConfiguredBeeRpcEndpoint;
}

/** A manager that named no endpoint of its own, and the answer a failed read gives. */
const NO_BEE_RPC_ENDPOINT: ConfiguredBeeRpcEndpoint = { configured: false, host: null };

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
      beeRpcEndpoint?: ConfiguredBeeRpcEndpoint;
    }>('/config');
    return {
      host: body.host,
      srtPassphrase: body.srtPassphrase ?? null,
      chequebookFloorBzz:
        body.chequebookFloorBzz ?? DEFAULT_CHEQUEBOOK_FLOOR_BZZ,
      beeRpcEndpoint: body.beeRpcEndpoint ?? NO_BEE_RPC_ENDPOINT,
    };
  } catch {
    return {
      host: window.location.hostname,
      srtPassphrase: null,
      chequebookFloorBzz: DEFAULT_CHEQUEBOOK_FLOOR_BZZ,
      beeRpcEndpoint: NO_BEE_RPC_ENDPOINT,
    };
  }
}

export async function fetchProfiles(): Promise<Profile[]> {
  const body = await getJson<{ profiles: Profile[] }>('/profiles');
  return body.profiles;
}

/**
 * One deployment's SRT passphrase, or null when it publishes under the
 * host-wide one.
 *
 * Asked for at the moment an operator opens or copies that deployment's
 * publish URL, because the passphrase goes in the URL's query. It is not on
 * the profile row, and what comes back belongs to the view that asked: never
 * merged into the deployments store, where every page would hold it.
 */
export async function fetchSrtPassphrase(name: string): Promise<string | null> {
  const body = await getJson<{ srt_passphrase: string | null }>(
    `/profiles/${encodeURIComponent(name)}/srt-passphrase`,
  );
  return body.srt_passphrase;
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

/**
 * Runs one of the manager's deployment scripts and waits for it to finish.
 *
 * These routes answer with a Server-Sent Events stream, so the 200 says only
 * that the script started and the exit code arrives in the last frame. Reading
 * the status alone reported a deploy.sh that exited 1 as a green "Starting".
 */
async function postAction(name: string, action: ProfileAction): Promise<void> {
  try {
    const res = await apiFetch(
      `/profiles/${encodeURIComponent(name)}/${action}`,
      { method: 'POST', body: {}, signal: AbortSignal.timeout(ACTION_TIMEOUT_MS) },
    );
    if (!res.ok) await failWith(res, `request failed (${res.status})`);
    if (!res.body) {
      throw new Error('The manager answered the action with no stream to read.');
    }
    await readScriptOutcome(res.body);
  } catch (caught) {
    if (isTimeout(caught)) throw new Error(actionTimedOutMessage());
    // Nothing else on the page is fetching while a deploy runs, so a session
    // that ended under it surfaces here and nowhere else. Asked before the
    // message travels, so the operator lands on the sign-in page rather than
    // reading that the deploy broke.
    if (caught instanceof ScriptStreamEndedError) await checkSessionAfterStreamClosed();
    throw caught;
  }
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

export function createProfile(
  body: CreateProfileBody,
  signal?: AbortSignal,
): Promise<Profile> {
  return sendJson<Profile>('POST', '/profiles', body, signal);
}

// engine_settings is create-only: a running deployment's are saved through
// PUT /profiles/:name/engine-settings, which claims the deploy they need and
// works out which containers to recreate. The update schema strips the key, so
// carrying it in this type would only promise something the manager ignores.
export type UpdateProfileBody = Omit<
  CreateProfileBody,
  'name' | 'host' | 'srt_passphrase' | 'engine_settings'
> & {
  /** The revision the drawer loaded the notes at, sent along with an edited note. */
  notes_revision?: number;
  /**
   * Absent keeps the passphrase the deployment holds, because no page is given
   * the value and so no page can send it back. An explicit null is the
   * operator putting the deployment back on the host-wide passphrase, which is
   * the only way left to clear it.
   */
  srt_passphrase?: string | null;
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
  /** Applied to every member: where its Bee node reaches the chain, and how much of one it runs. */
  rpc_endpoint_source?: RpcEndpointSource;
  rpc_endpoint?: string | null;
  node_mode?: NodeMode | null;
  /** The stack version every member runs. Absent means the manager's default one. */
  stack_version_id?: number;
  /** What every member is created with. Absent leaves the version's own fallbacks standing. */
  engine_settings?: EngineSettings;
}

export function createDeploymentGroup(
  body: CreateGroupBody,
  signal?: AbortSignal,
): Promise<GroupWithMembers> {
  return sendJson<GroupWithMembers>('POST', '/groups', body, signal);
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
