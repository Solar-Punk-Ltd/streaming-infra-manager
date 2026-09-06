import http from 'node:http';

import {
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  SESSION_COOKIE_NAME,
} from '@streaming-infra-manager/common';
import express from 'express';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { notFound } from '../../src/api/middleware/notFound.js';
import { requireSameSite } from '../../src/api/middleware/requireSameSite.js';
import {
  createRequireSession,
  signedInUser,
} from '../../src/api/middleware/requireSession.js';
import { createAuthRouter } from '../../src/api/routes/auth.js';
import { createEventsRouter } from '../../src/api/routes/events.js';
import { AuthService } from '../../src/domain/auth/AuthService.js';
import type { LoginLimiter } from '../../src/domain/auth/LoginLimiter.js';
import { OpenStreams } from '../../src/domain/auth/OpenStreams.js';
import { EventBus } from '../../src/domain/EventBus.js';

import { InMemoryCredentialRepository } from './InMemoryCredentialRepository.js';
import { InMemorySessionRepository } from './InMemorySessionRepository.js';
import { InMemoryUserRepository } from './InMemoryUserRepository.js';

/**
 * The manager's gate on a random port, wired exactly as `api/server.ts` wires
 * it: the same-site check over everything, /health and /auth open, a session
 * required for everything mounted after them.
 *
 * `/profiles` here stands in for the rest of the API. It answers with the
 * signed-in username so a test can tell a real pass from an accidental one.
 * `/events` is the real events router, because a stream that outlives its
 * session is the thing several of these tests are about.
 */
export interface AuthTestApp {
  url: string;
  authService: AuthService;
  users: InMemoryUserRepository;
  sessions: InMemorySessionRepository;
  close(): Promise<void>;
}

export async function startAuthTestApp(
  limiter?: LoginLimiter,
): Promise<AuthTestApp> {
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository(users);
  const openStreams = new OpenStreams();
  const authService = new AuthService(
    users,
    sessions,
    new InMemoryCredentialRepository(users, sessions),
    openStreams,
    limiter,
  );
  const requireSession = createRequireSession(authService);
  const events = createEventsRouter(new EventBus(), openStreams);

  const app = express();
  app.use(requireSameSite);
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.use('/auth', createAuthRouter(authService, requireSession));
  app.use(requireSession);

  app.use('/events', events.router);

  app.get('/profiles', (req, res) => {
    res.json({ user: signedInUser(req).username });
  });
  app.post('/profiles', (req, res) => {
    res.status(201).json({ user: signedInUser(req).username });
  });

  app.use(notFound);
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not report a port');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    authService,
    users,
    sessions,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // A stream still running would keep the server from closing, the same
        // reason api/server.ts drops them before its own close.
        events.closeAll();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export interface CallOptions {
  body?: unknown;
  cookie?: string | null;
  /** Left off to prove a write without it is refused. */
  requestedWith?: boolean;
  headers?: Record<string, string>;
}

export interface CallResult {
  status: number;
  body: unknown;
  setCookie: string[];
  retryAfter: string | null;
}

export async function call(
  app: AuthTestApp,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<CallResult> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.requestedWith !== false) {
    headers[REQUESTED_WITH_HEADER] = REQUESTED_WITH_VALUE;
  }
  if (options.cookie) headers.cookie = options.cookie;

  const res = await fetch(`${app.url}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    /* a non-JSON body is reported as the raw text */
  }

  return {
    status: res.status,
    body,
    setCookie: res.headers.getSetCookie(),
    retryAfter: res.headers.get('retry-after'),
  };
}

/** The `sim_session=<token>` pair from a Set-Cookie list, or null. */
export function sessionCookieFrom(setCookie: string[]): string | null {
  const header = setCookie.find((value) =>
    value.startsWith(`${SESSION_COOKIE_NAME}=`),
  );
  const pair = header?.split(';')[0];
  return pair && !pair.endsWith('=') ? pair : null;
}

export function tokenFrom(cookiePair: string): string {
  return cookiePair.slice(`${SESSION_COOKIE_NAME}=`.length);
}

export interface SignedIn {
  cookie: string;
  token: string;
}

/** Long enough that a slow machine is not mistaken for a stream that stayed. */
const STREAM_END_TIMEOUT_MS = 2_000;

export interface EventStream {
  /** Resolves when the server ends it, rejects once the deadline passes. */
  waitForEnd(timeoutMs?: number): Promise<void>;
  /** Whether the server has ended it, without waiting for it to. */
  hasEnded(): boolean;
  /** Hangs up from this side, the way closing the browser tab would. */
  close(): void;
}

/**
 * Opens `GET /events` and follows it, the way the page's EventSource does.
 *
 * Nothing here reads the events themselves: what the tests ask is whether the
 * stream is still running, and every wait carries a deadline so a stream that
 * never ends fails its test instead of hanging the suite.
 */
export async function openEventStream(
  app: AuthTestApp,
  cookie: string,
): Promise<EventStream> {
  const hangUp = new AbortController();
  const res = await fetch(`${app.url}/events`, {
    headers: {
      cookie,
      [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE,
    },
    signal: hangUp.signal,
  });

  if (res.status !== 200 || !res.body) {
    throw new Error(`the event stream did not open: ${res.status}`);
  }

  let ended = false;
  const reader = res.body.getReader();
  const drained = (async (): Promise<void> => {
    try {
      let chunk = await reader.read();
      while (!chunk.done) chunk = await reader.read();
    } catch {
      // A destroyed socket arrives as a read error rather than a clean end.
      // Either way the stream is over, which is all these tests ask.
    }
    ended = true;
  })();

  return {
    hasEnded: () => ended,
    close: () => hangUp.abort(),
    async waitForEnd(timeoutMs = STREAM_END_TIMEOUT_MS): Promise<void> {
      let deadline: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          drained,
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () =>
                reject(
                  new Error(`the stream was still open after ${timeoutMs}ms`),
                ),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}

/** Signs in over HTTP and hands back the cookie the browser would keep. */
export async function signIn(
  app: AuthTestApp,
  username: string,
  password: string,
): Promise<SignedIn> {
  const res = await call(app, 'POST', '/auth/login', {
    body: { username, password },
  });
  if (res.status !== 204) {
    throw new Error(
      `sign-in failed with ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }

  const cookie = sessionCookieFrom(res.setCookie);
  if (!cookie) throw new Error('sign-in set no session cookie');
  return { cookie, token: tokenFrom(cookie) };
}
