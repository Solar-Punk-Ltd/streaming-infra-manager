import type {
  CreateProfileBody,
  DeploymentGroup,
  Profile,
  ProfileKind,
} from './types';

const LOCAL_HOSTS = new Set(['', 'localhost', '0.0.0.0', '127.0.0.1']);

/**
 * The address to reach a profile's components: the profile's own host when it
 * names a concrete server, otherwise the manager-reported server host.
 */
export function hostFor(profile: Profile, serverHost: string): string {
  const profileHost = profile.host?.trim() ?? '';
  if (!LOCAL_HOSTS.has(profileHost)) return profileHost;
  return serverHost || window.location.hostname;
}

export function componentUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

export function clientUrl(profile: Profile, serverHost: string): string | null {
  const client = profile.containers.find((c) => c.service === 'client');
  if (!client) return null;
  const port = client.ports.CLIENT_PORT;
  if (!port) return null;
  return componentUrl(hostFor(profile, serverHost), port);
}

const SRT_DEFAULT_APP_STREAM = 'live/stream';
const SRS_SRT_BASE_PORT = 10001;

/**
 * Ready-to-copy SRT publish URL for a streamer profile (OBS/FFmpeg target).
 * Uses the deployed srs container's published SRT port, falling back to the
 * slot's default (base + slot*10). Returns null when no SRT port is known yet.
 */
export function srtPublishUrl(
  profile: Profile,
  serverHost: string,
  passphrase?: string | null,
): string | null {
  const srs = profile.containers.find((c) => c.service === 'srs');
  const port =
    srs?.ports.SRS_SRT_PORT ??
    (profile.port_slot > 0
      ? SRS_SRT_BASE_PORT + profile.port_slot * 10
      : null);
  if (!port) return null;
  const host = hostFor(profile, serverHost);
  const base = `srt://${host}:${port}?streamid=#!::r=${SRT_DEFAULT_APP_STREAM},m=publish`;
  return passphrase ? `${base}&passphrase=${passphrase}` : base;
}

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

const STREAM_UPLOADER = 'stream-uploader';

const KIND_DEFAULT_COMPONENTS: Record<ProfileKind, string[]> = {
  streamer: ['srs', 'stream-uploader', 'bee-uploader'],
  viewer: ['client', 'bee-gateway'],
  custom: [],
};

export function profileServices(profile: Profile): string[] {
  if (profile.components && profile.components.length > 0) {
    return profile.components;
  }
  return KIND_DEFAULT_COMPONENTS[profile.kind] ?? [];
}

export function profileNeedsUploader(profile: Profile): boolean {
  return profileServices(profile).includes(STREAM_UPLOADER);
}

export function hasStamp(profile: Profile): boolean {
  return !!(profile.stamp_id && profile.stamp_id.trim());
}

export function uploaderDeployed(profile: Profile): boolean {
  return profile.containers.some((c) => c.service === STREAM_UPLOADER);
}

/** A stamp exists and the held-back uploader still needs deploying. */
export function canDeployUploader(profile: Profile): boolean {
  return (
    profileNeedsUploader(profile) &&
    hasStamp(profile) &&
    !uploaderDeployed(profile)
  );
}

async function postAction(
  name: string,
  action: 'deploy' | 'stop' | 'deploy-uploader',
): Promise<void> {
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

export interface BeeAddress {
  ethereum: string;
  overlay?: string;
}

export interface BeeWallet {
  bzzBalance: string;
  nativeTokenBalance: string;
}

export interface BeeStamp {
  batchID: string;
  utilization: number;
  usable: boolean;
  label?: string;
  depth: number;
  amount: string;
  bucketDepth: number;
  blockNumber: number;
  immutableFlag: boolean;
  exists: boolean;
  batchTTL: number;
}

export interface BuyStampInput {
  amount: string;
  depth: number;
  label?: string;
  immutable?: boolean;
}

/** Best-effort extraction of the API's error message, falling back to `fallback`. */
async function extractApiError(res: Response, fallback: string): Promise<string> {
  try {
    const err = (await res.json()) as { error?: string; message?: string };
    return err.message ?? err.error ?? fallback;
  } catch {
    return fallback;
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(await extractApiError(res, `request failed (${res.status})`));
  }
  return (await res.json()) as T;
}

export function fetchStampAddress(name: string): Promise<BeeAddress> {
  return getJson<BeeAddress>(
    `/profiles/${encodeURIComponent(name)}/stamp/address`,
  );
}

export function fetchStampWallet(name: string): Promise<BeeWallet> {
  return getJson<BeeWallet>(
    `/profiles/${encodeURIComponent(name)}/stamp/wallet`,
  );
}

export async function fetchStamps(name: string): Promise<BeeStamp[]> {
  const body = await getJson<{ stamps: BeeStamp[] }>(
    `/profiles/${encodeURIComponent(name)}/stamp/stamps`,
  );
  return body.stamps;
}

export async function buyStamp(
  name: string,
  input: BuyStampInput,
): Promise<{ batchID: string }> {
  const res = await fetch(`/profiles/${encodeURIComponent(name)}/stamp/buy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(await extractApiError(res, `buy failed (${res.status})`));
  }
  return (await res.json()) as { batchID: string };
}

export async function setStamp(
  name: string,
  stampId: string,
): Promise<Profile> {
  const res = await fetch(`/profiles/${encodeURIComponent(name)}/stamp/set`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stamp_id: stampId }),
  });
  if (!res.ok) {
    throw new Error(
      await extractApiError(res, `set stamp failed (${res.status})`),
    );
  }
  return (await res.json()) as Profile;
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
