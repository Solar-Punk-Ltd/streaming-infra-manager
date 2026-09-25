/**
 * `GET /profiles/:name/srt-ingest`, the route the deployment page reads.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * It answers the reading whole, since the page renders every part of it, and
 * it sits behind the session like every other per-deployment read.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';

import express from 'express';

import {
  measuredSrtIngest,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  SESSION_COOKIE_NAME,
  type SrtIngestReading,
} from '@streaming-infra-manager/common';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { createRequireSession } from '../../src/api/middleware/requireSession.js';
import { requireSameSite } from '../../src/api/middleware/requireSameSite.js';
import { createSrtIngestRouter } from '../../src/api/routes/srtIngest.js';
import type { AuthService } from '../../src/domain/auth/AuthService.js';
import { ProfileNotFoundError } from '../../src/domain/errors/index.js';
import type { SrtIngestHealthService } from '../../src/domain/srtIngest/SrtIngestHealthService.js';

const BROKEN_UP: SrtIngestReading = measuredSrtIngest({
  windowSeconds: 60,
  reports: 2,
  connections: 1,
  counts: { received: 12_957, lost: 761, retransmitted: 731, dropped: 763 },
});

const session = {
  async sessionFor(token: string) {
    return token === 'test-session'
      ? {
          user: { id: 7, username: 'operator', isAdmin: false },
          tokenHash: 'test-hash',
          expiresAt: new Date(Date.now() + 60_000),
        }
      : null;
  },
} as unknown as AuthService;

async function testApi(reading: SrtIngestReading = BROKEN_UP) {
  const asked: string[] = [];
  const srtIngest = {
    async read(name: string): Promise<SrtIngestReading> {
      asked.push(name);
      if (name === 'missing') throw new ProfileNotFoundError(name);
      return reading;
    },
  } as unknown as SrtIngestHealthService;

  const app = express();
  app.use(requireSameSite);
  app.use(express.json());
  app.use(createRequireSession(session));
  app.use('/profiles', createSrtIngestRouter(srtIngest));
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  return {
    asked,
    async get(path: string, authenticated = true) {
      return fetch(`${base}${path}`, {
        headers: {
          ...(authenticated ? { cookie: `${SESSION_COOKIE_NAME}=test-session` } : {}),
          [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE,
        },
      });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('the SRT ingest route', () => {
  it('answers the whole reading to a signed-in caller', async (t) => {
    const api = await testApi();
    t.after(() => api.close());

    const response = await api.get('/profiles/stage/srt-ingest');

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), BROKEN_UP);
    assert.deepEqual(api.asked, ['stage']);
  });

  it('answers a minute with no reports in it as that, with no numbers on it', async (t) => {
    const api = await testApi({ state: 'no_reports', windowSeconds: 60 });
    t.after(() => api.close());

    const response = await api.get('/profiles/stage/srt-ingest');

    assert.deepEqual(await response.json(), { state: 'no_reports', windowSeconds: 60 });
  });

  it('needs a session, and asks nothing without one', async (t) => {
    const api = await testApi();
    t.after(() => api.close());

    const response = await api.get('/profiles/stage/srt-ingest', false);

    assert.equal(response.status, 401);
    assert.deepEqual(api.asked, []);
  });

  it('refuses a name no deployment could have', async (t) => {
    const api = await testApi();
    t.after(() => api.close());

    const response = await api.get('/profiles/Not%20A%20Name/srt-ingest');

    assert.equal(response.status, 400);
    assert.deepEqual(api.asked, []);
  });

  it('answers 404 for a deployment this manager does not have', async (t) => {
    const api = await testApi();
    t.after(() => api.close());

    const response = await api.get('/profiles/missing/srt-ingest');

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'profile_not_found', name: 'missing' });
  });
});
