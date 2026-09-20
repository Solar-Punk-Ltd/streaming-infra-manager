import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';

import express from 'express';

import {
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  SESSION_COOKIE_NAME,
  type UploaderLifecycleReading,
} from '@streaming-infra-manager/common';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { createRequireSession } from '../../src/api/middleware/requireSession.js';
import { requireSameSite } from '../../src/api/middleware/requireSameSite.js';
import { createProfilesRouter } from '../../src/api/routes/profiles.js';
import type { AuthService } from '../../src/domain/auth/AuthService.js';
import { ProfileNotFoundError } from '../../src/domain/errors/index.js';
import type { ProfileService } from '../../src/domain/ProfileService.js';
import type { UploaderLifecycleService } from '../../src/domain/UploaderLifecycleService.js';
import { uploaderHealthStub } from '../support/uploaderHealthStub.js';

const LIVE: UploaderLifecycleReading = {
  state: 'available',
  streams: [
    {
      adminId: '11111111-1111-4111-8111-111111111111',
      runNumber: 2,
      state: 'live',
      initialAgeMs: 4_000,
    },
  ],
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

async function testApi(reading: UploaderLifecycleReading = LIVE) {
  const asked: string[] = [];
  const lifecycle = {
    async read(name: string): Promise<UploaderLifecycleReading> {
      asked.push(name);
      if (name === 'missing') throw new ProfileNotFoundError(name);
      return reading;
    },
  } as UploaderLifecycleService;

  const app = express();
  app.use(requireSameSite);
  app.use(express.json());
  app.use(createRequireSession(session));
  app.use(
    '/profiles',
    createProfilesRouter(
      {} as ProfileService,
      uploaderHealthStub(),
      false,
      lifecycle,
    ),
  );
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  return {
    asked,
    get(path: string, authenticated = true) {
      return fetch(`${base}${path}`, {
        headers: {
          ...(authenticated
            ? { cookie: `${SESSION_COOKIE_NAME}=test-session` }
            : {}),
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

describe('the uploader lifecycle route', () => {
  it('answers the credential-free projection to a signed-in caller', async (t) => {
    const api = await testApi();
    t.after(() => api.close());

    const response = await api.get('/profiles/stage/uploader-lifecycle');

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), LIVE);
    assert.deepEqual(api.asked, ['stage']);
  });

  it('needs a session and performs no lifecycle read without one', async (t) => {
    const api = await testApi();
    t.after(() => api.close());

    const response = await api.get(
      '/profiles/stage/uploader-lifecycle',
      false,
    );

    assert.equal(response.status, 401);
    assert.deepEqual(api.asked, []);
  });

  it('validates deployment identity before service work', async (t) => {
    const api = await testApi();
    t.after(() => api.close());

    const response = await api.get(
      '/profiles/Not%20A%20Name/uploader-lifecycle',
    );

    assert.equal(response.status, 400);
    assert.deepEqual(api.asked, []);
  });

  it('answers 404 for a deployment this manager does not have', async (t) => {
    const api = await testApi();
    t.after(() => api.close());

    const response = await api.get('/profiles/missing/uploader-lifecycle');

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: 'profile_not_found',
      name: 'missing',
    });
  });
});
