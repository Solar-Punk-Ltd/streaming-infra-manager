/**
 * Integration-test helpers: a thin HTTP client for the running manager API
 * plus polling utilities. These tests talk to a LIVE stack (Postgres + manager
 * + Docker + deploy scripts) over HTTP only — they import nothing from `src`,
 * so they exercise the real system exactly as the frontend does.
 *
 * Base URL is `MANAGER_URL` (default http://localhost:9876).
 */
import assert from 'node:assert/strict';

export const BASE = process.env.MANAGER_URL ?? 'http://localhost:9876';

/** Prefix for every resource these tests create, so cleanup is unambiguous. */
export const PREFIX = 'itest';

// Service names — mirrors common/src/constants.ts (kept as literals so the
// tests stay decoupled from the app package).
export const CLIENT = 'client';
export const BEE_GATEWAY = 'bee-gateway';
export const SRS = 'srs';
export const BEE_UPLOADER = 'bee-uploader';
export const STREAM_UPLOADER = 'stream-uploader';

// Valid feed-owner addresses (0x + 40 hex) for viewer/client profiles.
export const FEED_OWNER_A = '0x1111111111111111111111111111111111111111';
export const FEED_OWNER_B = '0x2222222222222222222222222222222222222222';

export interface Container {
  service: string;
  ports: Record<string, number>;
}

export interface Profile {
  name: string;
  kind: string;
  status: string;
  components: string[] | null;
  notes: string | null;
  feed_owner: string | null;
  feed_topic: string | null;
  stamp_id: string | null;
  containers: Container[];
  pendingStamp: boolean;
  group_id: number | null;
  last_error: string | null;
}

export interface Group {
  id: number;
  name: string;
  size: number;
  created_at: string;
}

async function rawRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers:
      body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, text: await res.text() };
}

/** Request expecting a 2xx; throws with the server's body on any error. */
export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const { status, text } = await rawRequest(method, path, body);
  if (status < 200 || status >= 300) {
    throw new Error(`${method} ${path} -> ${status}: ${text}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Request that returns status + parsed body without throwing on 4xx/5xx. */
export async function apiRaw(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const { status, text } = await rawRequest(method, path, body);
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    /* keep raw text */
  }
  return { status, body: parsed };
}

export async function healthy(): Promise<boolean> {
  try {
    const { status } = await rawRequest('GET', '/health');
    return status === 200;
  } catch {
    return false;
  }
}

export interface CreateBody {
  name: string;
  kind: string;
  components?: string[];
  notes?: string | null;
  host?: string;
  feed_owner?: string;
  private_key?: string;
  public_key?: string;
  stamp_id?: string;
}

export const listProfiles = () =>
  api<{ profiles: Profile[] }>('GET', '/profiles').then((r) => r.profiles);

export const getProfile = (name: string) =>
  api<Profile>('GET', `/profiles/${encodeURIComponent(name)}`);

export async function getProfileOrNull(name: string): Promise<Profile | null> {
  const { status, body } = await apiRaw(
    'GET',
    `/profiles/${encodeURIComponent(name)}`,
  );
  if (status === 404) return null;
  if (status < 200 || status >= 300) {
    throw new Error(`GET /profiles/${name} -> ${status}`);
  }
  return body as Profile;
}

export const createProfile = (body: CreateBody) => 
  api<Profile>('POST', '/profiles', body);

export const updateProfile = (name: string, body: Record<string, unknown>) =>
  api<Profile>('PUT', `/profiles/${encodeURIComponent(name)}`, body);

export const deployProfile = async (name: string) => {
   const r = await apiRaw(
     'POST',
     `/profiles/${encodeURIComponent(name)}/deploy`,
     {},
   );
   if (r.status < 200 || r.status >= 300) {
     throw new Error(`POST /profiles/${name}/deploy -> ${r.status}`);
   }
   return r;
 }
 
export const stopProfile = async (name: string) => {
  const r = await apiRaw('POST', `/profiles/${encodeURIComponent(name)}/stop`, {});
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`POST /profiles/${name}/stop -> ${r.status}`);
  }
  return r;
};

export const removeProfile = async (name: string) => {
  const r = await apiRaw('DELETE', `/profiles/${encodeURIComponent(name)}`);
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`DELETE /profiles/${name} -> ${r.status}`);
  }
  return r;
};

export const listGroups = () =>
  api<{ groups: Group[] }>('GET', '/groups').then((r) => r.groups);

export const createGroup = (body: {
  group_name: string;
  size: number;
  kind: string;
  components?: string[];
  feed_owner?: string;
  notes?: string | null;
  host?: string;
}) =>
  api<{ group: Group; profiles: Profile[] }>('POST', '/groups', body);

export const updateGroupConfig = (id: number, body: Record<string, unknown>) =>
  api<{ group: Group; profiles: Profile[] }>(
    'PATCH',
    `/groups/${id}/config`,
    body,
  );

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The sorted set of service names actually deployed for a profile. */
export const serviceNames = (p: Profile): string[] =>
  p.containers.map((c) => c.service).sort();

/**
 * Poll until `name` reaches `target`. Fails fast if it lands in ERROR while we
 * were expecting a non-ERROR state (surfacing last_error for diagnostics).
 */
export async function waitForStatus(
  name: string,
  target: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<Profile> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  let last: Profile | null = null;
  while (Date.now() < deadline) {
    last = await getProfileOrNull(name);
    if (last?.status === target) return last;
    if (last?.status === 'ERROR' && target !== 'ERROR') {
      throw new Error(
        `profile ${name} entered ERROR while awaiting ${target}: ${last.last_error ?? '(no message)'}`,
      );
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms awaiting ${name}=${target}; last status=${last?.status ?? 'absent'}`,
  );
}

export async function waitForGone(
  name: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await getProfileOrNull(name)) === null) return;
    await sleep(intervalMs);
  }
  throw new Error(`timed out awaiting removal of ${name}`);
}

export async function waitForGroupGone(
  id: number,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const groups = await listGroups();
    if (!groups.some((g) => g.id === id)) return;
    await sleep(intervalMs);
  }
  throw new Error(`timed out awaiting auto-removal of empty group ${id}`);
}

/** A collision-resistant name within the itest namespace. */
export function uniqueName(base: string): string {
  const rand = Math.random().toString(36).slice(2, 6);
  return `${PREFIX}-${base}-${rand}`;
}

/** Best-effort teardown: remove each profile and wait for it to disappear. */
export async function cleanup(names: Iterable<string>): Promise<void> {
  for (const name of names) {
    try {
      if ((await getProfileOrNull(name)) === null) continue;
      await removeProfile(name);
      await waitForGone(name, { timeoutMs: 60_000 });
    } catch {
      /* best-effort — a leftover is logged by the test, not fatal */
    }
  }
}

/** Preflight used by every suite's before() hook. */
export async function requireStack(): Promise<void> {
  assert.ok(
    await healthy(),
    `manager API not reachable at ${BASE} — start the full stack first (see manager/test/integration/README.md)`,
  );
}
