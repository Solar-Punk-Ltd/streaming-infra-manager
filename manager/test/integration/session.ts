/**
 * What carries the sign-in: the cookie a login answer sets, and the headers
 * every later request has to send.
 *
 * The names are the ones in common/src/auth.ts, as literals: the integration
 * tests import nothing from `src`, so they speak to the manager the way the
 * browser does and nothing else.
 */
export const SESSION_COOKIE_NAME = 'sim_session';
export const REQUESTED_WITH_HEADER = 'x-requested-with';
export const REQUESTED_WITH_VALUE = 'streaming-infra-manager';

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/** The session cookie among a sign-in answer's Set-Cookie headers, as a Cookie header value, or null. */
export function sessionCookieFrom(setCookies: readonly string[]): string | null {
  const wanted = `${SESSION_COOKIE_NAME}=`;
  for (const header of setCookies) {
    const pair = header.split(';')[0]?.trim() ?? '';
    if (pair.startsWith(wanted) && pair.length > wanted.length) return pair;
  }
  return null;
}

export interface RequestShape {
  method: string;
  /** The Cookie header value of the session, or null when signed out. */
  cookie: string | null;
  hasBody: boolean;
  /** Left out on purpose by the test that proves a write without it is refused. */
  requestedWith?: boolean;
}

/** The session on every request, the write header on every write, the content type on a body. */
export function requestHeaders(shape: RequestShape): Record<string, string> {
  const headers: Record<string, string> = {};
  if (shape.cookie !== null) headers.cookie = shape.cookie;
  const isWrite = !SAFE_METHODS.has(shape.method.toUpperCase());
  if (isWrite && (shape.requestedWith ?? true)) {
    headers[REQUESTED_WITH_HEADER] = REQUESTED_WITH_VALUE;
  }
  if (shape.hasBody) headers['content-type'] = 'application/json';
  return headers;
}
