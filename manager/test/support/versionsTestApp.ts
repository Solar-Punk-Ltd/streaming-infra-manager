import http from 'node:http';
import { join } from 'node:path';

import express from 'express';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { notFound } from '../../src/api/middleware/notFound.js';
import { createVersionsRouter } from '../../src/api/routes/versions.js';
import { EventBus } from '../../src/domain/EventBus.js';
import { StackVersionService } from '../../src/domain/versions/StackVersionService.js';

import { FakeScriptSpawner } from './FakeScriptSpawner.js';
import { InMemoryStackVersionRepository } from './InMemoryStackVersionRepository.js';

/**
 * The versions routes on a random port, mounted the way `api/server.ts` mounts
 * them, over the in-memory table and a script runner that spawns nothing.
 *
 * The session gate is deliberately not here: `requireSession.test.ts` and
 * `serverGateOrder.test.ts` already pin that every router mounted after it is
 * behind it, and repeating the sign-in in every route test would hide what the
 * route itself answers.
 */
export interface VersionsTestApp {
  url: string;
  repository: InMemoryStackVersionRepository;
  runner: FakeScriptSpawner;
  bus: EventBus;
  /** The tree the bundled version ships with. Its parent is where the pin file goes. */
  bundledRoot: string;
  close(): Promise<void>;
}

/**
 * The bundled root defaults to a path of this test's own, never the machine's,
 * so whether this checkout happens to carry a pinned stack commit changes
 * nothing here.
 */
export async function startVersionsTestApp(
  versionsRoot: string,
  bundledRoot: string = join(versionsRoot, 'bundled-tree'),
): Promise<VersionsTestApp> {
  const repository = new InMemoryStackVersionRepository();
  repository.seedBundled();
  const runner = new FakeScriptSpawner();
  const bus = new EventBus();
  const service = new StackVersionService(repository, runner, bus, versionsRoot, { openReferences: async () => [], pendingShipmentBuildIds: async () => [] }, bundledRoot);

  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use('/versions', createVersionsRouter(service));
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
    repository,
    runner,
    bus,
    bundledRoot,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Resolves on the next `version.changed`.
 *
 * A build's stream ends before the row is written: the SSE `done` frame is sent
 * from the same handler that starts the bookkeeping, and the bookkeeping is
 * asynchronous. So a test that reads the stream and immediately asks the table
 * what happened would read the row as it was mid-build.
 */
export function nextVersionChange(app: VersionsTestApp): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = app.bus.subscribe((event) => {
      if (event.type !== 'version.changed') return;
      unsubscribe();
      resolve();
    });
  });
}

export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Reads a Server-Sent Events body to its end and hands back the frames, the way
 * the browser's own reader in `versionsApi.ts` does.
 */
export async function readSseFrames(res: Response): Promise<SseFrame[]> {
  const body = await res.text();
  const frames: SseFrame[] = [];

  for (const block of body.split('\n\n')) {
    const lines = block.split('\n');
    const event = lines
      .find((line) => line.startsWith('event: '))
      ?.slice('event: '.length);
    const data = lines
      .find((line) => line.startsWith('data: '))
      ?.slice('data: '.length);
    if (event) frames.push({ event, data: data ?? '' });
  }

  return frames;
}
