import { adminUrlProblem, type AdminLinkTestOutcome } from '@streaming-infra-manager/common';

/** What Test connection asks a web2 admin with: the address and token the uploader would be given. */
export interface AdminLinkProbeTarget {
  url: string;
  token: string;
  /** The address the deployment's stream key derives, compared with the admin's feed owner, or null where there is none to compare. */
  feedOwner: string | null;
}

export interface AdminLinkProbeOptions {
  /** How long each of the two requests may take in all. */
  timeoutMs?: number;
  /** The most of a body that is read. The admin's own answers are a few hundred bytes. */
  maxBodyBytes?: number;
}

export type AdminLinkProbe = (target: AdminLinkProbeTarget, options?: AdminLinkProbeOptions) => Promise<AdminLinkTestOutcome>;

/** The stream uploader's own lookup timeout, `DEFAULT_LOOKUP_TIMEOUT_MS`, so an admin the uploader would give up on reads as unreachable here too. */
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/**
 * The lookup the uploader makes on every publish, for a stream nobody can have
 * declared: the admin mints stream ids as random UUIDs and never the nil one.
 * `video` is one of the admin's two media types, because a lookup under any
 * other is refused before the admin looks. The admin checks the token before
 * anything else, so its own 404 for this path says it took the token.
 */
const UNUSED_STREAM_PATH = '/api/internal/streams/by-ingest/video/00000000-0000-0000-0000-000000000000';
const CONFIG_PATH = '/api/config';

/** The error codes the admin's own 404 and 401 carry, which tell its answers from any other server's. */
const STREAM_NOT_FOUND = 'stream_not_found';
const UNAUTHENTICATED = 'unauthenticated';

/** What one request came to: no answer, a redirect, or a status with the body read as JSON, undefined when it was not JSON or ran past the bound. */
type Answer = { kind: 'none' } | { kind: 'redirect' } | { kind: 'answered'; status: number; body: unknown };

/**
 * Reads a body as JSON, up to the bound. Undefined for a body past the bound
 * or one that is not JSON. Throws only when the body stops arriving, which the
 * timeout ends.
 */
async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (!response.body || (Number.isFinite(declared) && declared > maxBytes)) {
    await response.body?.cancel();
    return undefined;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  } catch {
    return undefined;
  }
}

/** One GET that follows no redirect, gives up at the timeout, and reads a bounded body. Nothing it met travels further than its kind. */
async function ask(url: string, headers: Record<string, string>, timeoutMs: number, maxBytes: number): Promise<Answer> {
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal });
  } catch {
    return { kind: 'none' };
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: 'redirect' };
  }
  try {
    return { kind: 'answered', status: response.status, body: await boundedJson(response, maxBytes) };
  } catch {
    return { kind: 'none' };
  }
}

function fieldOf(body: unknown, field: string): unknown {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[field] : undefined;
}

function errorCodeOf(answer: Answer): string | null {
  if (answer.kind !== 'answered') return null;
  const code = fieldOf(answer.body, 'error');
  return typeof code === 'string' ? code : null;
}

/** The address the admin signs its catalog with, off its public config, or null. */
function feedOwnerOf(answer: Answer): string | null {
  if (answer.kind !== 'answered' || answer.status !== 200) return null;
  const owner = fieldOf(fieldOf(answer.body, 'feed'), 'owner');
  return typeof owner === 'string' && owner !== '' ? owner : null;
}

/** Two owners are one address whatever their case and whether they carry `0x`, as the uploader compares them. */
function sameFeedOwner(left: string, right: string): boolean {
  const normalise = (owner: string) => owner.trim().toLowerCase().replace(/^0x/, '');
  return normalise(left) === normalise(right);
}

/**
 * Asks a web2 admin what the stream uploader would ask it, and answers one
 * outcome code. The token goes to the internal lookup alone, the public config
 * is asked without it, and only when there is a stream address to compare its
 * owner with.
 *
 * It reaches whatever the manager's own host can reach, loopback and private
 * addresses included, as the uploader reaches whatever its host can. It never
 * throws, and nothing the far end sent reaches its answer.
 */
export const probeAdminLink: AdminLinkProbe = async (target, options = {}) => {
  if (adminUrlProblem(target.url) !== null) return 'invalid-address';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const base = target.url.replace(/\/+$/, '');

  const lookup = await ask(`${base}${UNUSED_STREAM_PATH}`, { authorization: `Bearer ${target.token}` }, timeoutMs, maxBytes);
  if (lookup.kind === 'none') return 'unreachable';
  if (lookup.kind === 'redirect') return 'redirected';
  if (lookup.status === 401 && errorCodeOf(lookup) === UNAUTHENTICATED) return 'token-refused';
  if (lookup.status !== 404 || errorCodeOf(lookup) !== STREAM_NOT_FOUND) return 'not-admin';
  if (target.feedOwner === null) return 'token-accepted';

  const owner = feedOwnerOf(await ask(`${base}${CONFIG_PATH}`, {}, timeoutMs, maxBytes));
  if (owner === null) return 'owner-unconfirmed';
  return sameFeedOwner(owner, target.feedOwner) ? 'linked' : 'owner-mismatch';
};
