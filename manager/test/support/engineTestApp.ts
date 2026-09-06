/**
 * The engine routes on a random port, with the profile service and the Docker
 * client stood in for.
 *
 * Only the router and the error handler, because what is under test here is
 * what the routes refuse and with which status. The session gate sits in front
 * of these in `api/server.ts` and has its own tests.
 */
import http from 'node:http';

import express from 'express';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { createEngineRouter } from '../../src/api/routes/engine.js';
import type { ContainerControl } from '../../src/domain/ContainerControl.js';
import type { ProfileService } from '../../src/domain/ProfileService.js';

export interface EngineTestApp {
  url: string;
  close(): Promise<void>;
}

export interface EngineCall {
  status: number;
  body: unknown;
}

export async function startEngineTestApp(
  profileService: ProfileService,
  containers: ContainerControl,
): Promise<EngineTestApp> {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use(createEngineRouter(profileService, containers));
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('engine test server did not report a port');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export async function callEngine(
  app: EngineTestApp,
  method: string,
  path: string,
  requestBody?: unknown,
): Promise<EngineCall> {
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
