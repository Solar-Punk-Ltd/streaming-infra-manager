/**
 * Stack settings sent with a new deployment and with a new group, through the
 * create routes, the real service and in-memory rows.
 *
 * Unit test, no database and no deploy script. `pnpm test` in manager/.
 *
 * The wizard edits a new deployment's settings before it exists, so they
 * travel on the create body and are stored as the row is inserted, which is
 * what its first deploy writes. They answer to the rules a save of the
 * deployment's settings page answers to, against the list its version gives a
 * deployment of that shape: a key the version does not declare, a key one of
 * the deployment's own controls decides, and a value the stack would read
 * differently are all refused, the key named and the value never repeated.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import type { ProfileWithContainers } from '../../src/types/index.js';
import { throwawayRoot } from '../support/throwawayRoot.js';
import { uploaderHealthStub } from '../support/uploaderHealthStub.js';

const root = throwawayRoot('create-stack-settings-');
process.env.SHLS_ROOT = root;

const { createGroupsRouter } = await import('../../src/api/routes/groups.js');
const { createProfilesRouter } = await import('../../src/api/routes/profiles.js');
const { profileServiceHarness } = await import('../support/profileServiceHarness.js');
const { call, startRouterTestApp } = await import('../support/routerTestApp.js');

const TOKEN = 'synthetic-admin-token-0123456789abcdef';

const ROOT_SAMPLE = `# === Stream Uploader ===
LOG_LEVEL=info
UPLOADER_START_GATES=chequebook-warn
ADMIN_API_URL=
ADMIN_API_TOKEN=
STAMP=
`;

beforeEach(() => {
  writeFileSync(join(root, '.env.sample'), ROOT_SAMPLE, 'utf8');
  writeFileSync(join(root, '.env'), 'LOG_LEVEL=info\nUPLOADER_START_GATES=chequebook-warn\n', 'utf8');
  mkdirSync(join(root, 'engines', 'srs'), { recursive: true });
  writeFileSync(join(root, 'engines', 'srs', '.env.sample'), '# === SRS Media Server ===\nHLS_FRAGMENT=\nSRS_LOG_TANK=console\n', 'utf8');
});

type Harness = ReturnType<typeof profileServiceHarness>;

async function appFor(harness: Harness) {
  const profiles = await startRouterTestApp(createProfilesRouter(harness.service, uploaderHealthStub(), false), '/profiles');
  const groups = await startRouterTestApp(createGroupsRouter(harness.service, false), '/groups');
  return {
    create: (body: unknown) => call(profiles, 'POST', '/profiles', body),
    createGroup: (body: unknown) => call(groups, 'POST', '/groups', body),
    close: async () => {
      await profiles.close();
      await groups.close();
    },
  };
}

function refusalOf(answer: { status: number; body: unknown }): string {
  assert.equal(answer.status, 400, JSON.stringify(answer.body));
  const { error, errors } = answer.body as { error: string; errors: string[] };
  assert.equal(error, 'validation_error');
  return errors.join(' ');
}

describe('POST /profiles with stack settings', () => {
  it('stores each value in the column its key belongs to, so the first deploy writes them', async () => {
    const harness = profileServiceHarness();
    const app = await appFor(harness);
    try {
      const created = await app.create({
        name: 'stage',
        kind: 'streamer',
        stack_settings: [
          { key: 'LOG_LEVEL', value: 'debug' },
          { key: 'ADMIN_API_URL', value: 'http://admin.internal' },
          { key: 'ADMIN_API_TOKEN', value: TOKEN },
        ],
      });

      assert.equal(created.status, 202, JSON.stringify(created.body));
      assert.deepEqual(await harness.profiles.stackSettingsOf('stage'), {
        plain: { LOG_LEVEL: 'debug', ADMIN_API_URL: 'http://admin.internal' },
        secretKeys: ['ADMIN_API_TOKEN'],
        revision: 0,
      });
      assert.deepEqual(await harness.profiles.stackSettingsForDeploy('stage'), {
        LOG_LEVEL: 'debug',
        ADMIN_API_URL: 'http://admin.internal',
        ADMIN_API_TOKEN: TOKEN,
      });
      assert.doesNotMatch(JSON.stringify(created.body), new RegExp(TOKEN));
    } finally {
      await app.close();
    }
  });

  it('stores nothing when the body names none, so the version values stand', async () => {
    const harness = profileServiceHarness();
    const app = await appFor(harness);
    try {
      const created = await app.create({ name: 'stage', kind: 'streamer' });

      assert.equal(created.status, 202, JSON.stringify(created.body));
      assert.deepEqual(await harness.profiles.stackSettingsForDeploy('stage'), {});
    } finally {
      await app.close();
    }
  });

  it('refuses a key the version does not declare, a key a control decides and a value the stack would read differently, naming each', async () => {
    const harness = profileServiceHarness();
    const app = await appFor(harness);
    try {
      const refused = refusalOf(await app.create({
        name: 'stage',
        kind: 'streamer',
        stack_settings: [
          { key: 'NOT_A_SETTING', value: 'x' },
          { key: 'STAMP', value: 'b'.repeat(64) },
          { key: 'HLS_FRAGMENT', value: '2' },
          { key: 'UPLOADER_START_GATES', value: 'sometimes' },
        ],
      }));

      assert.match(refused, /NOT_A_SETTING is not a setting this deployment's version declares\./);
      assert.match(refused, /STAMP is set by the deployment's postage stamp, not here\./);
      assert.match(refused, /HLS_FRAGMENT is set by the engine settings, not here\./);
      assert.match(refused, /UPLOADER_START_GATES must be one of chequebook-warn, warn, refuse\./);
      assert.equal(harness.profiles.rows.has('stage'), false, 'no deployment was created');
      assert.equal(harness.orchestrator.deploys.length, 0);
    } finally {
      await app.close();
    }
  });

  it('names a refused secret by its key and never repeats its value', async () => {
    const harness = profileServiceHarness();
    const app = await appFor(harness);
    const mangled = 'synthetic/token&with|sed-syntax';
    try {
      const refused = refusalOf(await app.create({
        name: 'stage',
        kind: 'streamer',
        stack_settings: [{ key: 'ADMIN_API_TOKEN', value: mangled }],
      }));

      assert.match(refused, /ADMIN_API_TOKEN must not contain/);
      assert.equal(refused.includes(mangled), false);
    } finally {
      await app.close();
    }
  });

  it('refuses a value that is not text, and a key that is not an env key, repeating neither', async () => {
    const harness = profileServiceHarness();
    const app = await appFor(harness);
    try {
      const notText = refusalOf(await app.create({ name: 'stage', kind: 'streamer', stack_settings: [{ key: 'LOG_LEVEL', value: 42 }] }));
      const notAKey = refusalOf(await app.create({ name: 'stage', kind: 'streamer', stack_settings: [{ key: 'LOG LEVEL', value: 'debug' }] }));

      assert.match(notText, /a settings value is text/);
      assert.doesNotMatch(notText, /42/);
      assert.match(notAKey, /a settings key starts with a letter or an underscore/);
      assert.doesNotMatch(notAKey, /debug/);
    } finally {
      await app.close();
    }
  });

  it('refuses a key named twice', async () => {
    const harness = profileServiceHarness();
    const app = await appFor(harness);
    try {
      const refused = refusalOf(await app.create({
        name: 'stage',
        kind: 'streamer',
        stack_settings: [{ key: 'LOG_LEVEL', value: 'debug' }, { key: 'LOG_LEVEL', value: 'warn' }],
      }));

      assert.match(refused, /LOG_LEVEL is named twice/);
    } finally {
      await app.close();
    }
  });
});

describe('POST /groups with stack settings', () => {
  it('gives every member the same values', async () => {
    const harness = profileServiceHarness();
    const app = await appFor(harness);
    try {
      const created = await app.createGroup({
        group_name: 'fleet',
        size: 2,
        kind: 'streamer',
        stack_settings: [{ key: 'LOG_LEVEL', value: 'debug' }, { key: 'ADMIN_API_TOKEN', value: TOKEN }],
      });

      assert.equal(created.status, 202, JSON.stringify(created.body));
      const members = (created.body as { profiles: ProfileWithContainers[] }).profiles.map((profile) => profile.name);
      assert.deepEqual(members, ['fleet-profile-1', 'fleet-profile-2']);
      for (const name of members) {
        assert.deepEqual(await harness.profiles.stackSettingsForDeploy(name), { LOG_LEVEL: 'debug', ADMIN_API_TOKEN: TOKEN }, name);
      }
      assert.doesNotMatch(JSON.stringify(created.body), new RegExp(TOKEN));
    } finally {
      await app.close();
    }
  });

  it('gives every rung of a node pool the same values', async () => {
    const harness = profileServiceHarness();
    const app = await appFor(harness);
    try {
      const created = await app.createGroup({
        group_name: 'pool',
        size: 4,
        abr_ladder: true,
        kind: 'custom',
        stack_settings: [{ key: 'LOG_LEVEL', value: 'warn' }],
      });

      assert.equal(created.status, 202, JSON.stringify(created.body));
      const members = (created.body as { profiles: ProfileWithContainers[] }).profiles;
      assert.equal(members.length, 4);
      for (const { name } of members) {
        assert.deepEqual(await harness.profiles.stackSettingsForDeploy(name), { LOG_LEVEL: 'warn' }, name);
      }
    } finally {
      await app.close();
    }
  });

  it('refuses the whole group when one value is refused, and creates no member', async () => {
    const harness = profileServiceHarness();
    const app = await appFor(harness);
    try {
      const refused = refusalOf(await app.createGroup({
        group_name: 'fleet',
        size: 2,
        kind: 'streamer',
        stack_settings: [{ key: 'LOG_LEVEL', value: 'debug' }, { key: 'STAMP', value: 'c'.repeat(64) }],
      }));

      assert.match(refused, /STAMP is set by the deployment's postage stamp, not here\./);
      assert.equal(harness.groups.groups.length, 0);
      assert.equal(harness.profiles.rows.size, 0);
    } finally {
      await app.close();
    }
  });
});
