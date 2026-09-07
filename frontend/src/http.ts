import {
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
} from '@streaming-infra-manager/common';

import { SIGN_IN_MESSAGES } from './auth/messages';

/**
 * Every call to the manager goes through here.
 *
 * Two things it adds. A header no cross-origin page can set without a CORS
 * preflight the manager never answers, which is what makes a write from
 * another site impossible even with the cookie attached. And one place where a
 * 401 turns into "you are signed out" for the whole app, so a session that
 * ended between two clicks lands on the sign-in page instead of a toast that
 * says nothing useful.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD']);

export class SessionEndedError extends Error {
  constructor() {
    super(SIGN_IN_MESSAGES.sessionEnded);
    this.name = 'SessionEndedError';
  }
}

type SessionEndedHandler = () => void;

let onSessionEnded: SessionEndedHandler | null = null;

/**
 * Registered by useSession. It is a single handler rather than a subscription
 * because there is one session and one place that renders it.
 */
export function setSessionEndedHandler(
  handler: SessionEndedHandler | null,
): void {
  onSessionEnded = handler;
}

export interface ApiRequest {
  method?: string;
  body?: unknown;
  /**
   * For the sign-in routes, where a 401 is the answer to the question asked
   * rather than a session that has ended.
   */
  allowUnauthorized?: boolean;
  /** Ends the request and its body stream, for a call nobody is waiting on. */
  signal?: AbortSignal;
}

export async function apiFetch(
  path: string,
  request: ApiRequest = {},
): Promise<Response> {
  const method = request.method ?? 'GET';
  const headers: Record<string, string> = {};

  if (!SAFE_METHODS.has(method)) {
    headers[REQUESTED_WITH_HEADER] = REQUESTED_WITH_VALUE;
  }
  if (request.body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal: request.signal,
  });

  if (res.status === 401 && !request.allowUnauthorized) {
    onSessionEnded?.();
    throw new SessionEndedError();
  }

  return res;
}

let sessionProbe: Promise<boolean> | null = null;

/**
 * Asks whether the session is still there, after a live stream stopped.
 *
 * A browser closes an `EventSource` for good when the server answers anything
 * but 200, and keeps reconnecting only when the failure was the network. So a
 * stream that has reached CLOSED is where a session ending goes unnoticed:
 * nothing else on the page is fetching. Concurrent calls share one probe, so
 * both streams closing together ask once. The answer says whether reopening
 * the stream is worth trying.
 */
export function checkSessionAfterStreamClosed(): Promise<boolean> {
  if (!sessionProbe) {
    sessionProbe = runSessionProbe().finally(() => {
      sessionProbe = null;
    });
  }
  return sessionProbe;
}

/** Resolves false only when the manager said the session is gone. */
async function runSessionProbe(): Promise<boolean> {
  try {
    const res = await apiFetch('/auth/session', { allowUnauthorized: true });
    if (res.status === 401) {
      onSessionEnded?.();
      return false;
    }
    return true;
  } catch {
    // A manager that cannot be reached is not a session that ended, and the
    // stream reopening is what will tell the two apart.
    return true;
  }
}

/** A refusal the manager explained: its error code travels with the message. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string | null,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ApiFailure {
  message: string;
  code: string | null;
}

async function extractApiError(
  res: Response,
  fallback: string,
): Promise<ApiFailure> {
  try {
    const err = (await res.json()) as {
      error?: string;
      message?: string;
      errors?: string[];
    };
    // `errors` first: it is where every 400 puts the only useful text. The
    // validation middleware answers {error:'validation_error', errors:[...]},
    // and so does ProfileConfigError. Reading `error` ahead of it showed the
    // operator the literal string "validation_error" and threw the reason
    // away, so "bee_publishers is required for a abr-uploader" arrived as a
    // single word carrying no information.
    const code = err.error ?? null;
    if (err.errors?.length) return { message: err.errors.join('. '), code };
    return { message: err.message ?? err.error ?? fallback, code };
  } catch {
    return { message: fallback, code: null };
  }
}

/** Throws with whatever the manager said went wrong. */
export async function failWith(
  res: Response,
  fallback: string,
): Promise<never> {
  const failure = await extractApiError(res, fallback);
  throw new ApiError(failure.message, failure.code, res.status);
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) await failWith(res, `request failed (${res.status})`);
  return (await res.json()) as T;
}

/** A write that answers with JSON. */
export async function sendJson<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await apiFetch(path, { method, body: body ?? {} });
  if (!res.ok) await failWith(res, `request failed (${res.status})`);
  return (await res.json()) as T;
}

/** A write that answers with nothing. */
export async function send(
  method: string,
  path: string,
  body?: unknown,
): Promise<void> {
  const res = await apiFetch(path, { method, body });
  if (!res.ok) await failWith(res, `request failed (${res.status})`);
  await res.text().catch(() => undefined);
}
