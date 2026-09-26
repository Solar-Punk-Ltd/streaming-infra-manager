/**
 * A new deployment, or a new group, created with the manager's stored web2
 * admin token, through the create routes, the real service and in-memory rows.
 *
 * Unit test, no database and no deploy script. `pnpm test` in manager/. The
 * copy itself happens in the insert's own SQL, which the database test
 * `managerAdminLink.test.ts` proves. This proves the create asks for it and
 * refuses what cannot work.
 *
 * The stored token never reaches the browser: the create says to use it, the
 * manager puts it in the new deployment's secret settings at insert, and no
 * answer carries it.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import { throwawayRoot } from '../support/throwawayRoot.js';
import { uploaderHealthStub } from '../support/uploaderHealthStub.js';

const root = throwawayRoot('create-with-manager-admin-token-');
process.env.SHLS_ROOT = root;

const { createGroupsRouter } = await import('../../src/api/routes/groups.js');
const { createProfilesRouter } = await import('../../src/api/routes/profiles.js');
const { profileServiceHarness } = await import('../support/profileServiceHarness.js');
const { call, startRouterTestApp } = await import('../support/routerTestApp.js');

const ADMIN_URL = 'https://admin.example.com';
const STORED_TOKEN = 'synthetic-stored-admin-token-fedcba9876543210';
const TYPED_TOKEN = 'synthetic-typed-admin-token-0123456789abcdef';

const SAMPLE_WITH_ADMIN = '# === Stream Uploader ===\nLOG_LEVEL=info\nSTAMP=\n\n# === Admin mode ===\nADMIN_API_URL=\nADMIN_API_TOKEN=\n';

function writeVersion(sample = SAMPLE_WITH_ADMIN): void {
  writeFileSync(join(root, '.env.sample'), sample, 'utf8');
  writeFileSync(join(root, '.env'), 'LOG_LEVEL=info\nADMIN_API_URL=\nADMIN_API_TOKEN=\n', 'utf8');
  mkdirSync(join(root, 'engines', 'srs'), { recursive: true });
  writeFileSync(join(root, 'engines', 'srs', '.env.sample'), '# === SRS Media Server ===\nHLS_FRAGMENT=\n', 'utf8');
}

beforeEach(() => writeVersion());

async function appFor(options: { storedToken?: string | null } = {}) {
  const harness = profileServiceHarness();
  harness.profiles.managerAdminLink.url = ADMIN_URL;
  harness.profiles.managerAdminLink.token = options.storedToken === undefined ? STORED_TOKEN : options.storedToken;
  const profiles = await startRouterTestApp(createProfilesRouter(harness.service, uploaderHealthStub(), false), '/profiles');
  const groups = await startRouterTestApp(createGroupsRouter(harness.service, false), '/groups');
  return {
    harness,
    create: (body: Record<string, unknown>) => call(profiles, 'POST', '/profiles', { name: 'stage', kind: 'streamer', ...body }),
    createGroup: (body: Record<string, unknown>) => call(groups, 'POST', '/groups', { group_name: 'fleet', size: 2, kind: 'streamer', ...body }),
    close: async () => {
      await profiles.close();
      await groups.close();
    },
  };
}

const LINKED = { stack_settings: [{ key: 'ADMIN_API_URL', value: ADMIN_URL }], use_manager_admin_token: true };

describe("a create that asks for the manager's stored web2 admin token", () => {
  it("puts the stored token in the new deployment's secret settings, and no answer carries it", async () => {
    const app = await appFor();
    try {
      const created = await app.create(LINKED);

      assert.equal(created.status, 202, JSON.stringify(created.body));
      assert.deepEqual(await app.harness.profiles.stackSettingsForDeploy('stage'), { ADMIN_API_URL: ADMIN_URL, ADMIN_API_TOKEN: STORED_TOKEN });
      assert.deepEqual((await app.harness.profiles.stackSettingsOf('stage'))?.secretKeys, ['ADMIN_API_TOKEN']);
      assert.equal(JSON.stringify(created.body).includes(STORED_TOKEN), false);
    } finally {
      await app.close();
    }
  });

  it('gives every member of a new group the stored token', async () => {
    const app = await appFor();
    try {
      const created = await app.createGroup(LINKED);

      assert.equal(created.status, 202, JSON.stringify(created.body));
      for (const name of ['fleet-profile-1', 'fleet-profile-2']) {
        assert.equal((await app.harness.profiles.stackSettingsForDeploy(name)).ADMIN_API_TOKEN, STORED_TOKEN, name);
      }
      assert.equal(JSON.stringify(created.body).includes(STORED_TOKEN), false);
    } finally {
      await app.close();
    }
  });

  it('is refused when the manager stores no token, and creates nothing', async () => {
    const app = await appFor({ storedToken: null });
    try {
      const refused = await app.create(LINKED);

      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      assert.equal((refused.body as { error: string }).error, 'admin_token_missing');
      assert.equal(app.harness.profiles.rows.has('stage'), false);
      assert.equal(app.harness.orchestrator.deploys.length, 0);
    } finally {
      await app.close();
    }
  });

  it('is refused beside a typed token, naming the key and never the token', async () => {
    const app = await appFor();
    try {
      const refused = await app.create({
        stack_settings: [{ key: 'ADMIN_API_URL', value: ADMIN_URL }, { key: 'ADMIN_API_TOKEN', value: TYPED_TOKEN }],
        use_manager_admin_token: true,
      });

      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.match(JSON.stringify(refused.body), /ADMIN_API_TOKEN is typed for this deployment and also asked for from the manager/);
      assert.equal(JSON.stringify(refused.body).includes(TYPED_TOKEN), false);
      assert.equal(app.harness.profiles.rows.has('stage'), false);
    } finally {
      await app.close();
    }
  });

  it('is refused for a version that does not declare ADMIN_API_TOKEN', async () => {
    writeVersion('# === Stream Uploader ===\nLOG_LEVEL=info\nSTAMP=\nADMIN_API_URL=\n');
    const app = await appFor();
    try {
      const refused = await app.create(LINKED);

      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.match(JSON.stringify(refused.body), /ADMIN_API_TOKEN is not a setting this deployment's version declares/);
    } finally {
      await app.close();
    }
  });

  it('copies nothing into a deployment whose create does not ask, even with a token stored', async () => {
    const app = await appFor();
    try {
      const created = await app.create({ stack_settings: [{ key: 'ADMIN_API_URL', value: '' }] });

      assert.equal(created.status, 202, JSON.stringify(created.body));
      assert.deepEqual(await app.harness.profiles.stackSettingsForDeploy('stage'), { ADMIN_API_URL: '' });
    } finally {
      await app.close();
    }
  });

  it('refuses a request for the stored token that is not true or false', async () => {
    const app = await appFor();
    try {
      const refused = await app.create({ ...LINKED, use_manager_admin_token: 'please' });

      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.equal(app.harness.profiles.rows.has('stage'), false);
    } finally {
      await app.close();
    }
  });
});
