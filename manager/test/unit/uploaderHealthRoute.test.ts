/**
 * `GET /profiles/:name/uploader-health`, the route the deployment page reads.
 *
 * Unit test, no database and no uploader. `pnpm test` in manager/.
 *
 * It answers the reading whole, because the page renders every part of it: the
 * state decides the step, `node` and `waitingSince` name what is being waited
 * for and since when, and `startGateWarnings` names the gate and the rung. It
 * sits behind the session like every other per-deployment read, since it says
 * which node a deployment is dialling.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';

import express from 'express';

import {
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  SESSION_COOKIE_NAME,
  type UploaderHealthReading,
} from '@streaming-infra-manager/common';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { createRequireSession } from '../../src/api/middleware/requireSession.js';
import { requireSameSite } from '../../src/api/middleware/requireSameSite.js';
import { createProfilesRouter } from '../../src/api/routes/profiles.js';
import type { AuthService } from '../../src/domain/auth/AuthService.js';
import { ProfileNotFoundError } from '../../src/domain/errors/index.js';
import type { ProfileService } from '../../src/domain/ProfileService.js';
import type { UploaderHealthService } from '../../src/domain/UploaderHealthService.js';

const WAITING: UploaderHealthReading = {
  state: 'waiting_for_node',
  reasons: ['node_unavailable'],
  waitingSince: '2026-09-17T09:00:00.000Z',
  node: { url: 'http://172.17.0.1:10015', attempts: 4, lastError: 'timeout of 20000ms exceeded' },
};

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

async function testApi(reading: UploaderHealthReading = WAITING) {
  const asked: string[] = [];
  const uploaderHealth = {
    async read(name: string): Promise<UploaderHealthReading> {
      asked.push(name);
      if (name === 'missing') throw new ProfileNotFoundError(name);
      return reading;
    },
  } as unknown as UploaderHealthService;

  const app = express();
  app.use(requireSameSite);
  app.use(express.json());
  app.use(createRequireSession(session));
  app.use('/profiles', createProfilesRouter({} as unknown as ProfileService, uploaderHealth, false));
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

describe('the uploader health route', () => {
  it('answers the whole reading to a signed-in caller', async (t) => {
    const api = await testApi();
    t.after(() => api.close());

    const response = await api.get('/profiles/stage/uploader-health');

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), WAITING);
    assert.deepEqual(api.asked, ['stage']);
  });

  it('answers a healthy uploader with no node fields on it', async (t) => {
    const api = await testApi({ state: 'ok', reasons: [] });
    t.after(() => api.close());

    const response = await api.get('/profiles/stage/uploader-health');

    assert.deepEqual(await response.json(), { state: 'ok', reasons: [] });
  });

  it('needs a session, and asks nothing without one', async (t) => {
    const api = await testApi();
    t.after(() => api.close());

    const response = await api.get('/profiles/stage/uploader-health', false);

    assert.equal(response.status, 401);
    assert.deepEqual(api.asked, []);
  });

  it('refuses a name no deployment could have', async (t) => {
    const api = await testApi();
    t.after(() => api.close());

    const response = await api.get('/profiles/Not%20A%20Name/uploader-health');

    assert.equal(response.status, 400);
    assert.deepEqual(api.asked, []);
  });

  it('answers 404 for a deployment this manager does not have', async (t) => {
    const api = await testApi();
    t.after(() => api.close());

    const response = await api.get('/profiles/missing/uploader-health');

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'profile_not_found', name: 'missing' });
  });
});
