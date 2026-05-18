import type { Profile, ProfileKind } from './types';

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

// --- mock fallback so the prototype is judgable without the backend running ---

const MOCK_PROFILES: Profile[] = [
  mock('viewer-alpha', 1, 'viewer', 'RUNNING'),
  mock('streamer-bravo', 2, 'streamer', 'RUNNING'),
  mock('streamer-charlie', 3, 'streamer', 'DEPLOYING'),
  mock('viewer-delta', 4, 'viewer', 'STOPPED'),
  mock(
    'custom-echo',
    5,
    'custom',
    'ERROR',
    'docker compose failed: pull access denied',
  ),
];

function mock(
  name: string,
  slot: number,
  kind: ProfileKind,
  status: Profile['status'],
  lastError: string | null = null,
): Profile {
  const now = new Date().toISOString();
  return {
    name,
    port_slot: slot,
    kind,
    notes: null,
    status,
    last_error: lastError,
    last_error_at: lastError ? now : null,
    created_at: now,
    updated_at: now,
    containers: [],
  };
}

export async function fetchProfiles(): Promise<{
  profiles: Profile[];
  usedMock: boolean;
}> {
  try {
    const res = await fetch('/profiles');
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { profiles: Profile[] };
    return { profiles: body.profiles, usedMock: false };
  } catch {
    return { profiles: MOCK_PROFILES, usedMock: true };
  }
}

export interface CreateProfileBody {
  name: string;
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
