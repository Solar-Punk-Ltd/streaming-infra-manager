import type { Container, Profile, ProfileKind } from './types';

// Slot N → service ports. Mirrors swarm-hls-stream/deploy/scripts/_lib.sh PORT_VARS.
function portFor(offset: number, slot: number): number {
  return 10000 + offset + slot * 10;
}

const SERVICES_BY_KIND: Record<ProfileKind, string[]> = {
  streamer: ['srs', 'stream-uploader', 'bee-uploader'],
  viewer: ['client', 'bee-gateway'],
  custom: ['srs', 'stream-uploader', 'bee-uploader', 'client', 'bee-gateway'],
};

const PORTS_BY_SERVICE: Record<string, (slot: number) => Container['ports']> = {
  srs: (s) => [
    { label: 'SRT', port: portFor(1, s) },
    { label: 'RTMP', port: portFor(2, s) },
    { label: 'HTTP', port: portFor(3, s) },
  ],
  'stream-uploader': (s) => [{ label: 'API', port: portFor(0, s) }],
  'bee-uploader': (s) => [
    { label: 'API', port: portFor(5, s) },
    { label: 'P2P', port: portFor(6, s) },
  ],
  client: (s) => [{ label: 'HTTP', port: portFor(4, s) }],
  'bee-gateway': (s) => [
    { label: 'API', port: portFor(7, s) },
    { label: 'P2P', port: portFor(8, s) },
  ],
};

export function containersFor(profile: Profile): Container[] {
  return SERVICES_BY_KIND[profile.kind].map((service) => ({
    service,
    ports: PORTS_BY_SERVICE[service](profile.port_slot),
  }));
}

export function clientUrl(
  profile: Profile,
  host = window.location.hostname,
): string | null {
  // Only profiles that include the `client` service expose a viewer URL.
  if (!SERVICES_BY_KIND[profile.kind].includes('client')) return null;
  return `http://${host}:${portFor(4, profile.port_slot)}`;
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
