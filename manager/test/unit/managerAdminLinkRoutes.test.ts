/**
 * The web2 admin link every new uploader deployment starts with, set once for
 * the whole manager on its Manager settings page, through
 * `GET` and `PUT /manager-settings/admin-link`.
 *
 * Unit test, no database and no Docker, over the real service, an in-memory
 * store and the real session gate. `pnpm test` in manager/.
 *
 * The address is answered in clear. The token never is, only whether one is
 * stored, and no refusal repeats either. A save names the revision it read,
 * so two operators editing at once cannot overwrite each other unseen.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';

import express from 'express';

import { REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE, SESSION_COOKIE_NAME } from '@streaming-infra-manager/common';

import { errorHandler } from '../../src/api/middleware/errorHandler.js';
import { createRequireSession } from '../../src/api/middleware/requireSession.js';
import { requireSameSite } from '../../src/api/middleware/requireSameSite.js';
import { createManagerSettingsRouter } from '../../src/api/routes/managerSettings.js';
import type { AuthService } from '../../src/domain/auth/AuthService.js';
import { ManagerAdminLinkService } from '../../src/domain/adminLink/ManagerAdminLinkService.js';
import { InMemoryManagerAdminLink } from '../support/InMemoryManagerAdminLink.js';

const ADMIN_URL = 'https://admin.example.com';
const TOKEN = 'synthetic-admin-token-0123456789abcdef';
const OTHER_TOKEN = 'synthetic-other-admin-token-9876543210fedcba';

const session = {
  async sessionFor(token: string) {
    return token === 'test-session'
      ? { user: { id: 7, username: 'operator', isAdmin: false }, tokenHash: 'test-hash', expiresAt: new Date(Date.now() + 60_000) }
      : null;
  },
} as unknown as AuthService;

async function testApi() {
  const store = new InMemoryManagerAdminLink();
  const app = express();
  app.use(requireSameSite);
  app.use(express.json());
  app.use(createRequireSession(session));
  app.use('/', createManagerSettingsRouter(new ManagerAdminLinkService(store)));
  app.use(errorHandler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  async function send(method: string, body?: unknown, authenticated = true) {
    const response = await fetch(`${base}/manager-settings/admin-link`, {
      method,
      headers: {
        ...(authenticated ? { cookie: `${SESSION_COOKIE_NAME}=test-session` } : {}),
        [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, body: text ? (JSON.parse(text) as unknown) : undefined, cache: response.headers.get('cache-control') };
  }

  return {
    store,
    read: (authenticated = true) => send('GET', undefined, authenticated),
    save: (body: unknown, authenticated = true) => send('PUT', body, authenticated),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function refusalOf(answer: { status: number; body: unknown }): string[] {
  assert.equal(answer.status, 400, JSON.stringify(answer.body));
  const { error, errors } = answer.body as { error: string; errors: string[] };
  assert.equal(error, 'validation_error');
  return errors;
}

describe('GET /manager-settings/admin-link', () => {
  it('answers no default before one is saved, and is not cached', async () => {
    const api = await testApi();
    try {
      const answer = await api.read();
      assert.equal(answer.status, 200);
      assert.deepEqual(answer.body, { url: null, tokenStored: false, revision: 0 });
      assert.equal(answer.cache, 'no-store');
    } finally {
      await api.close();
    }
  });
});

describe('PUT /manager-settings/admin-link', () => {
  it('saves an address and a token, and answers only that a token is stored', async () => {
    const api = await testApi();
    try {
      const saved = await api.save({ expectedRevision: 0, url: ADMIN_URL, token: TOKEN });
      const read = await api.read();

      assert.equal(saved.status, 200, saved.text);
      assert.deepEqual(saved.body, { url: ADMIN_URL, tokenStored: true, revision: 1 });
      assert.deepEqual(read.body, saved.body);
      for (const answer of [saved, read]) assert.equal(answer.text.includes(TOKEN), false);
      assert.equal((await api.store.storedLink()).token, TOKEN);
    } finally {
      await api.close();
    }
  });

  it('keeps the stored token when a save leaves it out, replaces it with a new one, and clears it on null', async () => {
    const api = await testApi();
    try {
      await api.save({ expectedRevision: 0, url: ADMIN_URL, token: TOKEN });
      const kept = await api.save({ expectedRevision: 1, url: `${ADMIN_URL}/v2` });
      assert.deepEqual(kept.body, { url: `${ADMIN_URL}/v2`, tokenStored: true, revision: 2 });
      assert.equal((await api.store.storedLink()).token, TOKEN);

      await api.save({ expectedRevision: 2, url: ADMIN_URL, token: OTHER_TOKEN });
      assert.equal((await api.store.storedLink()).token, OTHER_TOKEN);

      const cleared = await api.save({ expectedRevision: 3, url: ADMIN_URL, token: null });
      assert.deepEqual(cleared.body, { url: ADMIN_URL, tokenStored: false, revision: 4 });
      assert.equal((await api.store.storedLink()).token, null);
    } finally {
      await api.close();
    }
  });

  it('refuses an address on another origin that would keep the stored token, and takes it with a new token or a cleared one', async () => {
    const api = await testApi();
    try {
      await api.save({ expectedRevision: 0, url: ADMIN_URL, token: TOKEN });
      for (const elsewhere of ['https://admin2.example.com', 'http://admin.example.com', 'https://admin.example.com:8443']) {
        const refused = await api.save({ expectedRevision: 1, url: elsewhere });
        assert.deepEqual(refusalOf(refused), [
          'The address moves to another one than the stored token was saved with, and the manager sends its stored token only to the address it was saved with. Type the token again for the new address, or clear it.',
        ]);
      }
      assert.deepEqual((await api.read()).body, { url: ADMIN_URL, tokenStored: true, revision: 1 });

      const replaced = await api.save({ expectedRevision: 1, url: 'https://admin2.example.com', token: OTHER_TOKEN });
      assert.deepEqual(replaced.body, { url: 'https://admin2.example.com', tokenStored: true, revision: 2 });
      const cleared = await api.save({ expectedRevision: 2, url: ADMIN_URL, token: null });
      assert.deepEqual(cleared.body, { url: ADMIN_URL, tokenStored: false, revision: 3 });
    } finally {
      await api.close();
    }
  });

  it('takes an empty address as no default, which takes the stored token with it', async () => {
    const api = await testApi();
    try {
      await api.save({ expectedRevision: 0, url: ADMIN_URL, token: TOKEN });
      const cleared = await api.save({ expectedRevision: 1, url: '' });

      assert.deepEqual(cleared.body, { url: null, tokenStored: false, revision: 2 });
      assert.equal((await api.store.storedLink()).token, null);
    } finally {
      await api.close();
    }
  });

  it('refuses an address or a token the uploader would refuse, repeating neither, and stores nothing', async () => {
    const api = await testApi();
    try {
      const refused = await api.save({
        expectedRevision: 0,
        url: 'https://operator:synthetic-password@admin.example.com',
        token: 'synthetic-short-token',
      });

      assert.deepEqual(refusalOf(refused), [
        'ADMIN_API_URL cannot carry a user name or a password.',
        'ADMIN_API_TOKEN must be at least 32 characters.',
      ]);
      assert.equal(/synthetic-password|synthetic-short-token/.test(refused.text), false);
      assert.deepEqual((await api.read()).body, { url: null, tokenStored: false, revision: 0 });
    } finally {
      await api.close();
    }
  });

  it('refuses a save against an older revision, and keeps what the other save stored', async () => {
    const api = await testApi();
    try {
      await api.save({ expectedRevision: 0, url: ADMIN_URL, token: TOKEN });
      const late = await api.save({ expectedRevision: 0, url: 'https://admin2.example.com' });

      assert.equal(late.status, 409, late.text);
      assert.equal((late.body as { error: string }).error, 'manager_settings_changed');
      assert.deepEqual((await api.read()).body, { url: ADMIN_URL, tokenStored: true, revision: 1 });
    } finally {
      await api.close();
    }
  });

  it('refuses a body of the wrong shape without repeating what it carried', async () => {
    const api = await testApi();
    try {
      for (const body of [
        { expectedRevision: 0, url: ADMIN_URL, token: TOKEN, extra: TOKEN },
        { expectedRevision: -1, url: ADMIN_URL },
        { expectedRevision: 0, url: 7 },
        { expectedRevision: 0, url: ADMIN_URL, token: [TOKEN] },
        { expectedRevision: 0, url: ADMIN_URL, token: { value: TOKEN } },
      ]) {
        const refused = await api.save(body);
        assert.equal(refused.status, 400, `${JSON.stringify(body)} answered ${refused.text}`);
        assert.equal(refused.text.includes(TOKEN), false, refused.text);
      }
      assert.equal((await api.store.storedLink()).token, null);
    } finally {
      await api.close();
    }
  });

  it('refuses both routes to a browser with no session', async () => {
    const api = await testApi();
    try {
      assert.equal((await api.read(false)).status, 401);
      assert.equal((await api.save({ expectedRevision: 0, url: ADMIN_URL, token: TOKEN }, false)).status, 401);
      assert.equal((await api.store.storedLink()).token, null);
    } finally {
      await api.close();
    }
  });
});
