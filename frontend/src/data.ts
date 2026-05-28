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

export async function fetchServerHost(): Promise<string> {
  try {
    const res = await fetch('/config');
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { host: string };
    return body.host;
  } catch {
    return window.location.hostname;
  }
}

export async function fetchProfiles(): Promise<Profile[]> {
  const res = await fetch('/profiles');
  if (!res.ok) throw new Error(`fetch profiles failed (${res.status})`);
  const body = (await res.json()) as { profiles: Profile[] };
  return body.profiles;
}

async function postAction(
  name: string,
  action: 'deploy' | 'stop',
): Promise<void> {
  const res = await fetch(`/profiles/${encodeURIComponent(name)}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    let msg = `${action} failed (${res.status})`;
    try {
      const err = (await res.json()) as { error?: string; message?: string };
      msg = err.error ?? err.message ?? msg;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }

  await res.text().catch(() => undefined);
}

export function deployProfile(name: string): Promise<void> {
  return postAction(name, 'deploy');
}

export function stopProfile(name: string): Promise<void> {
  return postAction(name, 'stop');
}

export async function deleteProfile(name: string): Promise<void> {
  const res = await fetch(`/profiles/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    let msg = `delete failed (${res.status})`;
    try {
      const err = (await res.json()) as { error?: string; message?: string };
      msg = err.error ?? err.message ?? msg;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
}

export async function createProfile(body: CreateProfileBody): Promise<Profile> {
  const res = await fetch('/profiles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `request failed (${res.status})`;
    try {
      const err = (await res.json()) as { error?: string; message?: string };
      msg = err.error ?? err.message ?? msg;
    } catch {
      // ignore
    }
    throw new Error(msg);
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
  feed_topic?: string;
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
    let msg = `request failed (${res.status})`;
    try {
      const err = (await res.json()) as { error?: string; message?: string };
      msg = err.error ?? err.message ?? msg;
    } catch {
      // ignore
    }
    throw new Error(msg);
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
    let msg = `request failed (${res.status})`;
    try {
      const err = (await res.json()) as { error?: string; message?: string };
      msg = err.error ?? err.message ?? msg;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  return (await res.json()) as Profile;
}
