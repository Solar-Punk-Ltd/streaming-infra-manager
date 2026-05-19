import type {
  CreateProfileBody,
  Profile,
  UpdateProfileBody,
} from './types';

export function clientUrl(
  profile: Profile,
  host = window.location.hostname,
): string | null {
  const client = profile.containers.find((c) => c.service === 'client');
  if (!client) return null;
  const port = client.ports.CLIENT_PORT;
  if (!port) return null;
  return `http://${host}:${port}`;
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
