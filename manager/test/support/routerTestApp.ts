/**
 * One router on a random port, with the error handler behind it.
 *
 * Only the router and the error handler, because what is under test is what
 * the routes refuse and with which status. The session gate sits in front of
 * every router in `api/server.ts` and has its own tests.
 */
import http from 'node:http';

import express, { type Router } from 'express';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';

export interface RouterTestApp {
  url: string;
  close(): Promise<void>;
}

export interface RouterCall {
  status: number;
  body: unknown;
}

/** @param mountPath where `api/server.ts` mounts this router, `/` for one that names its own paths. */
export async function startRouterTestApp(
  router: Router,
  mountPath = '/',
): Promise<RouterTestApp> {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use(mountPath, router);
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('router test server did not report a port');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export async function call(
  app: RouterTestApp,
  method: string,
  path: string,
  requestBody?: unknown,
): Promise<RouterCall> {
  const res = await fetch(`${app.url}${path}`, {
    method,
    ...(requestBody === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(requestBody),
        }),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    /* a text/plain answer is reported as it arrived */
  }
  return { status: res.status, body };
}
