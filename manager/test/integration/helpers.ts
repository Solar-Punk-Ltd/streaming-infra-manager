/**
 * Integration-test helpers: a thin HTTP client for the running manager API
 * plus polling utilities. These tests talk to a LIVE stack (Postgres + manager
 * + Docker + deploy scripts) over HTTP only. They import nothing from `src`,
 * so they exercise the real system exactly as the frontend does: signed in,
 * with the session cookie on every request and the write header on every
 * write.
 *
 * Where the suite points and whether it may run at all is decided in
 * target.ts, from the environment `op run --env-file` fills. See README.md.
 */
import assert from 'node:assert/strict';

import { IntegrationResources } from './IntegrationResources.js';
import { requestHeaders, sessionCookieFrom } from './session.js';
import {
  baseUrlOf,
  PASSWORD_VAR,
  runIdFrom,
  runName,
  targetProblem,
  USERNAME_VAR,
} from './target.js';

export { PREFIX } from './target.js';

export const BASE = baseUrlOf(process.env);

/** Every name this run makes carries it, and cleanup removes nothing without it. */
export const RUN_ID = runIdFrom(process.env);

const resources = new IntegrationResources(RUN_ID, (method, path, body, signal) => requestWith(method, path, body, { signal }));

// Service names — mirrors common/src/constants.ts (kept as literals so the
// tests stay decoupled from the app package).
export const CLIENT = 'client';
export const BEE_GATEWAY = 'bee-gateway';
export const SRS = 'srs';
export const BEE_UPLOADER = 'bee-uploader';
export const STREAM_UPLOADER = 'stream-uploader';

/** Ascending, as `<pool>-<rung>` member names and BEE_PUBLISHERS order them. */
export const RUNGS = ['360p', '480p', '720p', '1080p'] as const;

// Valid feed-owner addresses (0x + 40 hex) for viewer/client profiles.
export const FEED_OWNER_A = '0x1111111111111111111111111111111111111111';
export const FEED_OWNER_B = '0x2222222222222222222222222222222222222222';

export interface Container {
  service: string;
  ports: Record<string, number>;
}

export interface Profile {
  name: string;
  instance_id: string;
  kind: string;
  status: string;
  components: string[] | null;
  notes: string | null;
  feed_owner: string | null;
  feed_topic: string | null;
  stamp_id: string | null;
  bee_publishers: string | null;
  bee_url: string | null;
  containers: Container[];
  pendingStamp: boolean;
  group_id: number | null;
  last_error: string | null;
}

export interface Group {
  id: number;
  name: string;
  size: number;
  kind: string;
  created_at: string;
}

export interface RungNote {
  rung: string;
  reason: string;
}

export interface BeePublishersResult {
  ready: boolean;
  value: string | null;
  rungs: { rung: string; name: string; status: string; url: string }[];
  missing: RungNote[];
  warnings: RungNote[];
}

/** The session cookie of the signed-in client, sent on every request until signOut. */
let session: string | null = null;

export interface RequestOptions {
  signal?: AbortSignal;
  /** The cookie to send instead of the session's: null for none. */
  cookie?: string | null;
  /** Whether a write carries the request header. A test proves the refusal without it. */
  requestedWith?: boolean;
  /**
   * Sent as the body verbatim, in place of the JSON of `body`, for the test
   * that proves a write is refused before its body is read.
   */
  rawBody?: string;
}

async function rawRequest(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<{ status: number; text: string; setCookies: string[] }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    signal: options.signal ?? AbortSignal.timeout(30_000),
    headers: requestHeaders({
      method,
      cookie: options.cookie === undefined ? session : options.cookie,
      hasBody: body !== undefined || options.rawBody !== undefined,
      requestedWith: options.requestedWith,
    }),
    body: options.rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  return {
    status: res.status,
    text: await res.text(),
    setCookies: res.headers.getSetCookie(),
  };
}

/**
 * Signs in with the pair the environment carries and keeps the cookie for
 * every later request. The assertion messages carry the server's answer and
 * never the pair.
 */
export async function signIn(): Promise<void> {
  const username = process.env[USERNAME_VAR];
  const password = process.env[PASSWORD_VAR];
  assert.ok(username && password, `${USERNAME_VAR} and ${PASSWORD_VAR} must both be set`);

  const { status, text, setCookies } = await rawRequest(
    'POST',
    '/auth/login',
    { username, password },
    { cookie: null },
  );
  assert.equal(status, 204, `POST /auth/login -> ${status}: ${text}`);
  const cookie = sessionCookieFrom(setCookies);
  assert.ok(cookie, 'the sign-in answered 204 without setting the session cookie');
  session = cookie;
}

/**
 * Ends the session on the server and forgets its cookie. The cookie it held
 * is handed back, for the test that proves it no longer opens anything.
 */
export async function signOut(): Promise<string | null> {
  const ended = session;
  if (ended !== null) {
    const { status, text } = await rawRequest('POST', '/auth/logout', {});
    assert.equal(status, 204, `POST /auth/logout -> ${status}: ${text}`);
  }
  session = null;
  return ended;
}

/** Request expecting a 2xx. Creation evidence is saved before caller assertions. */
export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const { status, body: result } = await requestWith(method, path, body);
  if (status < 200 || status >= 300) {
    throw new Error(`${method} ${path} -> ${status}`);
  }
  return result as T;
}

/** Request that returns status + parsed body without throwing on 4xx/5xx. */
export function apiRaw(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return requestWith(method, path, body);
}

/** The same, sent the way a test wants it: without the cookie, or without the write header. */
export async function requestWith(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<{ status: number; body: unknown }> {
  const rawBody = options.rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined);
  let sentBody: unknown;
  try { sentBody = rawBody === undefined ? undefined : JSON.parse(rawBody); }
  catch { sentBody = undefined; }
  return resources.capture(method, path, sentBody, async () => {
    const { status, text } = await rawRequest(method, path, undefined, { ...options, rawBody });
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      /* keep raw text */
    }
    return { status, body: parsed };
  });
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
  bee_publishers?: string;
  bee_url?: string | null;
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

export const removeProfile = (name: string) => resources.remove(name);

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
  abr_ladder?: boolean;
  stamp_id?: string;
}) =>
  api<{ group: Group; profiles: Profile[] }>('POST', '/groups', body);

/** The assembled BEE_PUBLISHERS for a pool, or why it is being withheld. */
export const beePublishers = (id: number) =>
  api<BeePublishersResult>('GET', `/groups/${id}/bee-publishers`);

export const updateGroupConfig = (id: number, body: Record<string, unknown>) =>
  api<{ group: Group; profiles: Profile[] }>(
    'PATCH',
    `/groups/${id}/config`,
    body,
  );

export const addGroupMembers = (id: number, count: number) =>
  api<{ group: Group; profiles: Profile[] }>('POST', `/groups/${id}/members`, {
    count,
  });

export const getGroup = async (id: number): Promise<Group | null> =>
  (await listGroups()).find((g) => g.id === id) ?? null;

export const listGroupMembers = async (id: number): Promise<Profile[]> =>
  (await listProfiles()).filter((p) => p.group_id === id);

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

/**
 * Wait until a profile is RUNNING *and* its container snapshot holds exactly
 * `expected` services. The manager flips status to RUNNING just before it
 * writes the container snapshot, so polling on status alone can briefly see
 * RUNNING with empty/partial containers — this waits for both to settle.
 */
export async function waitForRunningServices(
  name: string,
  expected: string[],
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<Profile> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const wanted = [...expected].sort();
  const deadline = Date.now() + timeoutMs;
  let last: Profile | null = null;
  while (Date.now() < deadline) {
    last = await getProfileOrNull(name);
    if (last?.status === 'ERROR') {
      throw new Error(
        `profile ${name} entered ERROR: ${last.last_error ?? '(no message)'}`,
      );
    }
    if (last?.status === 'RUNNING') {
      const got = serviceNames(last);
      if (got.length === wanted.length && got.every((s, i) => s === wanted[i])) {
        return last;
      }
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `timed out awaiting ${name} RUNNING with services [${wanted.join(', ')}]; ` +
      `last status=${last?.status ?? 'absent'}, services=[${last ? serviceNames(last).join(', ') : ''}]`,
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

export async function waitForGroupSize(
  id: number,
  size: number,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  let last: number | undefined;
  while (Date.now() < deadline) {
    const group = await getGroup(id);
    last = group?.size;
    if (group && group.size === size) return;
    await sleep(intervalMs);
  }
  throw new Error(
    `timed out awaiting group ${id} size=${size}; last size=${last ?? 'absent'}`,
  );
}

/**
 * Wait until the deployed stream-uploader answers on its own `/health`.
 *
 * The manager reports RUNNING once the deploy script exits 0 and the container
 * snapshot is written — which a container that starts, throws and restarts
 * satisfies just as well as a working one. That is not hypothetical: an uploader
 * deployed before `BEE_PUBLISHERS` was passed through compose crash-looped on an
 * unresolvable BEE_URL while the manager reported it RUNNING throughout. Asking
 * the uploader itself is the only assertion that separates the two.
 */
export async function waitForUploaderHealthy(
  profile: Profile,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 3_000;

  const container = profile.containers.find(
    (c) => c.service === STREAM_UPLOADER,
  );
  assert.ok(container, 'no stream-uploader container in the snapshot');
  const port = container.ports.API_PORT;
  assert.ok(port, 'stream-uploader snapshot carries no API_PORT');

  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `stream-uploader for ${profile.name} never became healthy on :${port} (${last}) — ` +
      `it is most likely restarting; check \`docker logs\``,
  );
}

/** A name of this run's own, `itest-<run>-<base>-<random>`, the only kind cleanup removes. */
export function uniqueName(base: string): string {
  return runName(RUN_ID, base);
}

/** Reports every unresolved creation or cleanup failure through the suite's after hook. */
export const cleanup = () => resources.cleanup();

/**
 * Preflight used by every suite's before() hook: the target is declared, the
 * manager answers, and the sign-in works. A suite that cannot start fails
 * here, in words, rather than passing on nothing.
 */
export async function requireStack(): Promise<void> {
  const problem = targetProblem(process.env);
  assert.equal(problem, null, problem ?? '');
  assert.ok(
    await healthy(),
    `manager API not reachable at ${BASE}. Start the stack first, see manager/test/integration/README.md`,
  );
  await signIn();
}
