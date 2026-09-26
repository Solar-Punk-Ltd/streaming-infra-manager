/**
 * The two Test connection routes: one for an address typed on a page, with a
 * typed token or the manager's stored one, and one for what a deployment's
 * next deploy would give its uploader.
 *
 * Unit test, no database and no Docker, over the real tester and the real
 * session gate, with the probe replaced by one that records what it was asked.
 * The probe itself has its own test against fake admins. `pnpm test` in
 * manager/.
 *
 * An answer is an outcome code and nothing else. The stored token never
 * leaves the manager, and neither the address nor any token reaches an answer
 * or a log line.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it, type TestContext } from 'node:test';

import express from 'express';

import {
  type AdminLinkTestOutcome,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  SESSION_COOKIE_NAME,
} from '@streaming-infra-manager/common';

import type { AuthService } from '../../src/domain/auth/AuthService.js';
import { makeProfile } from '../support/profileFixtures.js';
import { throwawayRoot } from '../support/throwawayRoot.js';
import { InMemoryManagerAdminLink } from '../support/InMemoryManagerAdminLink.js';

const root = throwawayRoot('admin-link-test-routes-');
process.env.SHLS_ROOT = root;

const { writeFileSync } = await import('node:fs');
const { join } = await import('node:path');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');
const { errorHandler } = await import('../../src/api/middleware/errorHandler.js');
const { createRequireSession } = await import('../../src/api/middleware/requireSession.js');
const { requireSameSite } = await import('../../src/api/middleware/requireSameSite.js');
const { createAdminLinkTestRouter } = await import('../../src/api/routes/adminLinkTest.js');
const { AdminLinkTester } = await import('../../src/domain/adminLink/AdminLinkTester.js');

const ADMIN_URL = 'https://admin.example.com';
const TOKEN = 'synthetic-admin-token-0123456789abcdef';
const STORED_TOKEN = 'synthetic-stored-admin-token-fedcba9876543210';
const OWNER = `0x${'ab'.repeat(20)}`;

const session = {
  async sessionFor(token: string) {
    return token === 'test-session'
      ? { user: { id: 7, username: 'operator', isAdmin: false }, tokenHash: 'test-hash', expiresAt: new Date(Date.now() + 60_000) }
      : null;
  },
} as unknown as AuthService;

interface Probed {
  url: string;
  token: string;
  feedOwner: string | null;
}

async function testApi(options: { outcome?: AdminLinkTestOutcome; storedToken?: string | null; deployment?: Parameters<typeof makeProfile>[0] } = {}) {
  writeFileSync(join(root, '.env'), 'ENGINE=srs\nLOG_LEVEL=info\n', 'utf8');
  writeFileSync(join(root, '.env.sample'), '# === Admin mode ===\nADMIN_API_URL=\nADMIN_API_TOKEN=\n', 'utf8');
  const store = new InMemoryManagerAdminLink();
  if (options.storedToken) {
    store.url = ADMIN_URL;
    store.token = options.storedToken;
  }
  const harness = orchestratorHarness([makeProfile({ name: 'stage', ...options.deployment })]);
  const probed: Probed[] = [];
  const tester = new AdminLinkTester(store, harness.profiles.asRepository(), harness.orchestrator, async (target) => {
    probed.push(target);
    return options.outcome ?? 'linked';
  });

  const app = express();
  app.use(requireSameSite);
  app.use(express.json());
  app.use(createRequireSession(session));
  app.use('/', createAdminLinkTestRouter(tester));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  async function post(path: string, body: unknown, authenticated = true) {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        ...(authenticated ? { cookie: `${SESSION_COOKIE_NAME}=test-session` } : {}),
        [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, body: text ? (JSON.parse(text) as unknown) : undefined, cache: response.headers.get('cache-control') };
  }

  return {
    harness,
    probed,
    testTyped: (body: unknown, authenticated = true) => post('/manager-settings/admin-link/test', body, authenticated),
    testDeployment: (name = 'stage', authenticated = true) => post(`/profiles/${name}/settings/admin-link/test`, {}, authenticated),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Every line the manager logs while the test runs, from each level. */
function capturedLogs(t: TestContext): string[] {
  const lines: string[] = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    t.mock.method(console, level, (...args: unknown[]) => lines.push(args.map(String).join(' ')));
  }
  return lines;
}

function refusalOf(answer: { status: number; body: unknown }): string[] {
  assert.equal(answer.status, 400, JSON.stringify(answer.body));
  return (answer.body as { errors: string[] }).errors;
}

describe('POST /manager-settings/admin-link/test', () => {
  it('tests a typed address with a typed token and the stream address, and answers the outcome alone', async (t) => {
    const logs = capturedLogs(t);
    const api = await testApi({ outcome: 'owner-mismatch' });
    try {
      const answer = await api.testTyped({ url: ADMIN_URL, token: { source: 'typed', value: TOKEN }, feedOwner: OWNER });

      assert.equal(answer.status, 200, answer.text);
      assert.deepEqual(answer.body, { outcome: 'owner-mismatch' });
      assert.equal(answer.cache, 'no-store');
      assert.deepEqual(api.probed, [{ url: ADMIN_URL, token: TOKEN, feedOwner: OWNER }]);
      assert.ok(logs.some((line) => line.includes('owner-mismatch')), logs.join('\n'));
      for (const line of logs) assert.equal(line.includes(ADMIN_URL) || line.includes(TOKEN), false, line);
    } finally {
      await api.close();
    }
  });

  it("presents the manager's stored token, which never reaches the answer", async () => {
    const api = await testApi({ storedToken: STORED_TOKEN });
    try {
      const answer = await api.testTyped({ url: `${ADMIN_URL}/v2`, token: { source: 'stored' } });

      assert.deepEqual(answer.body, { outcome: 'linked' });
      assert.deepEqual(api.probed, [{ url: `${ADMIN_URL}/v2`, token: STORED_TOKEN, feedOwner: null }]);
      assert.equal(answer.text.includes(STORED_TOKEN), false);
    } finally {
      await api.close();
    }
  });

  it('sends the stored token to no origin but the one it was saved with, and asks nothing there', async () => {
    const api = await testApi({ storedToken: STORED_TOKEN });
    try {
      for (const elsewhere of ['https://admin2.example.com', 'http://admin.example.com', 'https://admin.example.com:8443']) {
        const answer = await api.testTyped({ url: elsewhere, token: { source: 'stored' } });
        assert.deepEqual(answer.body, { outcome: 'stored-token-elsewhere' });
      }
      assert.deepEqual(api.probed, []);

      const typed = await api.testTyped({ url: 'https://admin2.example.com', token: { source: 'typed', value: TOKEN } });
      assert.deepEqual(typed.body, { outcome: 'linked' });
      assert.deepEqual(api.probed, [{ url: 'https://admin2.example.com', token: TOKEN, feedOwner: null }]);
    } finally {
      await api.close();
    }
  });

  it('answers no-token without asking anything when the manager stores no token', async () => {
    const api = await testApi();
    try {
      const answer = await api.testTyped({ url: ADMIN_URL, token: { source: 'stored' } });

      assert.deepEqual(answer.body, { outcome: 'no-token' });
      assert.equal(api.probed.length, 0);
    } finally {
      await api.close();
    }
  });

  it('refuses an address or a token the uploader would refuse, repeating neither, and asks nothing', async () => {
    const api = await testApi();
    try {
      const address = refusalOf(await api.testTyped({ url: 'https://operator:synthetic-password@admin.example.com', token: { source: 'stored' } }));
      const token = refusalOf(await api.testTyped({ url: ADMIN_URL, token: { source: 'typed', value: 'synthetic-short-token' } }));
      const empty = refusalOf(await api.testTyped({ url: '', token: { source: 'stored' } }));

      assert.deepEqual(address, ['ADMIN_API_URL cannot carry a user name or a password.']);
      assert.deepEqual(token, ['ADMIN_API_TOKEN must be at least 32 characters.']);
      assert.deepEqual(empty, ['Type the address of the web2 admin to test.']);
      assert.equal(api.probed.length, 0);
    } finally {
      await api.close();
    }
  });

  it('refuses a body of the wrong shape without repeating what it carried', async () => {
    const api = await testApi();
    try {
      for (const body of [
        { url: ADMIN_URL, token: TOKEN },
        { url: ADMIN_URL, token: { source: 'typed' } },
        { url: ADMIN_URL, token: { source: 'elsewhere', value: TOKEN } },
        { url: ADMIN_URL, token: { source: 'stored' }, feedOwner: 'not-an-address' },
        { url: ADMIN_URL, token: { source: 'stored' }, extra: TOKEN },
      ]) {
        const refused = await api.testTyped(body);
        assert.equal(refused.status, 400, `${JSON.stringify(body)} answered ${refused.text}`);
        assert.equal(refused.text.includes(TOKEN), false, refused.text);
      }
      assert.equal(api.probed.length, 0);
    } finally {
      await api.close();
    }
  });

  it('refuses a browser with no session', async () => {
    const api = await testApi();
    try {
      assert.equal((await api.testTyped({ url: ADMIN_URL, token: { source: 'typed', value: TOKEN } }, false)).status, 401);
      assert.equal(api.probed.length, 0);
    } finally {
      await api.close();
    }
  });
});

describe('POST /profiles/:name/settings/admin-link/test', () => {
  it("tests what the next deploy gives the uploader, with the deployment's stream address", async () => {
    const api = await testApi({ deployment: { has_private_key: true, public_key: OWNER } });
    try {
      api.harness.profiles.stackSettings.set('stage', { ADMIN_API_URL: ADMIN_URL, ADMIN_API_TOKEN: TOKEN });
      const answer = await api.testDeployment();

      assert.equal(answer.status, 200, answer.text);
      assert.deepEqual(answer.body, { outcome: 'linked' });
      assert.deepEqual(api.probed, [{ url: ADMIN_URL, token: TOKEN, feedOwner: OWNER }]);
      assert.equal(answer.text.includes(TOKEN), false);
    } finally {
      await api.close();
    }
  });

  it('compares no owner for a deployment that signs with its version key, whose address the manager does not hold', async () => {
    const api = await testApi();
    try {
      api.harness.profiles.stackSettings.set('stage', { ADMIN_API_URL: ADMIN_URL, ADMIN_API_TOKEN: TOKEN });
      await api.testDeployment();

      assert.equal(api.probed[0]?.feedOwner, null);
    } finally {
      await api.close();
    }
  });

  it('answers not-linked for a deployment with no address, and no-token for one with an address and no token, asking nothing', async () => {
    const api = await testApi();
    try {
      assert.deepEqual((await api.testDeployment()).body, { outcome: 'not-linked' });
      api.harness.profiles.stackSettings.set('stage', { ADMIN_API_URL: ADMIN_URL });
      assert.deepEqual((await api.testDeployment()).body, { outcome: 'no-token' });
      assert.equal(api.probed.length, 0);
    } finally {
      await api.close();
    }
  });

  it('answers invalid-address for an address the uploader could not use, asking nothing', async () => {
    const api = await testApi();
    try {
      api.harness.profiles.stackSettings.set('stage', { ADMIN_API_URL: 'admin.example.com', ADMIN_API_TOKEN: TOKEN });
      assert.deepEqual((await api.testDeployment()).body, { outcome: 'invalid-address' });
      assert.equal(api.probed.length, 0);
    } finally {
      await api.close();
    }
  });

  it('answers 404 for a deployment that does not exist, and 401 without a session', async () => {
    const api = await testApi();
    try {
      assert.equal((await api.testDeployment('missing')).status, 404);
      assert.equal((await api.testDeployment('stage', false)).status, 401);
    } finally {
      await api.close();
    }
  });
});
