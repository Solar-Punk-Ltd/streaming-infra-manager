/**
 * The three routes of a deployment's own settings, through the real service,
 * an orchestrator over in-memory rows, and a runner that spawns nothing.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * A save stores and changes nothing that runs. The list then says which
 * settings the running containers are behind on, and Apply redeploys only the
 * containers that read them. What is refused is refused with a status and a
 * sentence an operator can act on, and nothing answered carries a secret.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { DeploymentSettingsCatalog } from '@streaming-infra-manager/common';
import { Router } from 'express';

import type { SessionInfo } from '../../src/domain/auth/AuthService.js';
import { ALLOCATION_CONTRACT } from '../support/allocationContract.js';
import { makeProfile } from '../support/profileFixtures.js';
import { throwawayRoot } from '../support/throwawayRoot.js';

const root = throwawayRoot('deployment-settings-routes-');
process.env.SHLS_ROOT = root;

const { orchestratorHarness, untilRunning } = await import('../support/orchestratorHarness.js');
const { createDeploymentSettingsRouter } = await import('../../src/api/routes/deploymentSettings.js');
const { DeploymentSettingsService } = await import('../../src/domain/settings/DeploymentSettingsService.js');
const { call, startRouterTestApp } = await import('../support/routerTestApp.js');

const STAMP = 'a'.repeat(64);
const SECRET = 'synthetic-admin-token';
/** A save names the instance as a UUID, which the fixture's own default is not. */
const INSTANCE_ID = '6f1c2b1e-3a4d-4c5e-9f60-7a8b9c0d1e2f';

function writeVersion(): void {
  writeFileSync(join(root, '.env'), 'ENGINE=srs\nLOG_LEVEL=debug\nADMIN_API_TOKEN=\n', 'utf8');
  writeFileSync(
    join(root, '.env.sample'),
    '# === Stream Uploader ===\nLOG_LEVEL=debug\nADMIN_API_TOKEN=\nUPLOADER_START_GATES=chequebook-warn\nSTAMP=\n',
    'utf8',
  );
}

function sessionFor(username: string): SessionInfo {
  return {
    user: { id: 1, username, isAdmin: false },
    tokenHash: 'not-a-token',
    expiresAt: new Date(Date.now() + 60_000),
  };
}

/** The router as `api/server.ts` mounts it, behind a session unless the test asks for none. */
async function appFor(options: { signedIn?: boolean; status?: 'RUNNING' | 'STOPPED' } = {}) {
  writeVersion();
  const stored = makeProfile({ name: 'stage', stamp_id: STAMP, instance_id: INSTANCE_ID });
  const harness = orchestratorHarness([stored]);
  await harness.versions.setContract(1, {
    ...structuredClone(ALLOCATION_CONTRACT),
    serviceEnvKeys: { 'stream-uploader': ['ADMIN_API_TOKEN', 'LOG_LEVEL', 'STAMP', 'UPLOADER_START_GATES'], srs: ['SRS_SRT_PORT'] },
  });
  await harness.orchestrator.startDeploy(stored, undefined);
  harness.runner.finish(0);
  await untilRunning(harness.profiles, 'stage');
  if (options.status === 'STOPPED') harness.profiles.rows.set('stage', { ...harness.profiles.rows.get('stage')!, status: 'STOPPED' });

  const service = new DeploymentSettingsService(
    harness.profiles.asRepository(),
    harness.containers.asRepository(),
    harness.orchestrator,
  );
  const outer = Router();
  if (options.signedIn !== false) {
    const session = sessionFor('operator');
    outer.use((req, _res, next) => {
      req.authSession = session;
      req.user = session.user;
      next();
    });
  }
  outer.use(createDeploymentSettingsRouter(service));
  const app = await startRouterTestApp(outer);
  const instanceId = harness.profiles.rows.get('stage')!.instance_id;
  return { app, harness, instanceId };
}

async function listed(app: Awaited<ReturnType<typeof startRouterTestApp>>): Promise<DeploymentSettingsCatalog> {
  const answered = await call(app, 'GET', '/profiles/stage/settings');
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  return answered.body as DeploymentSettingsCatalog;
}

describe('GET /profiles/:name/settings', () => {
  it('lists the version keys with nothing behind straight after a deploy, and is not cached', async () => {
    const { app } = await appFor();
    try {
      const response = await fetch(`${app.url}/profiles/stage/settings`);
      const catalog = (await response.json()) as DeploymentSettingsCatalog;

      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(catalog.entries.map((entry) => entry.key), ['LOG_LEVEL', 'ADMIN_API_TOKEN', 'UPLOADER_START_GATES', 'STAMP']);
      assert.deepEqual(catalog.drift, { keys: [], services: [], fullRedeploy: false });
    } finally {
      await app.close();
    }
  });
});

describe('PUT /profiles/:name/settings', () => {
  it('stores a value, answers the new revision, and lists it as the deployment own and behind', async () => {
    const { app, instanceId } = await appFor();
    try {
      const saved = await call(app, 'PUT', '/profiles/stage/settings', {
        expectedInstanceId: instanceId,
        expectedRevision: 0,
        entries: [{ key: 'LOG_LEVEL', value: 'warn' }, { key: 'ADMIN_API_TOKEN', value: SECRET }],
      });
      const catalog = await listed(app);

      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.deepEqual(saved.body, { revision: 1 });
      const logLevel = catalog.entries.find((entry) => entry.key === 'LOG_LEVEL');
      assert.equal(logLevel?.source, 'deployment');
      assert.equal(logLevel?.value, 'warn');
      assert.deepEqual(catalog.drift, { keys: ['LOG_LEVEL', 'ADMIN_API_TOKEN'], services: ['stream-uploader'], fullRedeploy: false });
      assert.doesNotMatch(JSON.stringify(catalog), new RegExp(SECRET));
    } finally {
      await app.close();
    }
  });

  it('refuses a save made against an older revision', async () => {
    const { app, instanceId } = await appFor();
    try {
      const body = { expectedInstanceId: instanceId, expectedRevision: 0, entries: [{ key: 'LOG_LEVEL', value: 'warn' }] };
      await call(app, 'PUT', '/profiles/stage/settings', body);

      const late = await call(app, 'PUT', '/profiles/stage/settings', body);

      assert.equal(late.status, 409);
      assert.equal((late.body as { error: string }).error, 'deployment_settings_changed');
    } finally {
      await app.close();
    }
  });

  it('refuses a key a control of the deployment decides, and names the control', async () => {
    const { app, instanceId } = await appFor();
    try {
      const refused = await call(app, 'PUT', '/profiles/stage/settings', {
        expectedInstanceId: instanceId,
        expectedRevision: 0,
        entries: [{ key: 'STAMP', value: 'b'.repeat(64) }],
      });

      assert.equal(refused.status, 400);
      assert.deepEqual(refused.body, {
        error: 'validation_error',
        errors: ["STAMP is set by the deployment's postage stamp, not here."],
        name: 'stage',
      });
    } finally {
      await app.close();
    }
  });

  it('refuses a request without a session, and stores nothing', async () => {
    const { app, harness, instanceId } = await appFor({ signedIn: false });
    try {
      const refused = await call(app, 'PUT', '/profiles/stage/settings', {
        expectedInstanceId: instanceId,
        expectedRevision: 0,
        entries: [{ key: 'LOG_LEVEL', value: 'warn' }],
      });

      assert.equal(refused.status, 401);
      assert.equal(harness.profiles.stackSettings.get('stage'), undefined);
    } finally {
      await app.close();
    }
  });
});

describe('POST /profiles/:name/settings/apply', () => {
  it('answers that nothing needed recreating when nothing is behind', async () => {
    const { app, harness, instanceId } = await appFor();
    try {
      const applied = await call(app, 'POST', '/profiles/stage/settings/apply', { expectedInstanceId: instanceId });

      assert.equal(applied.status, 200);
      assert.deepEqual(applied.body, { recreated: [] });
      assert.equal(harness.runner.runs.length, 1, 'only the first deploy ran');
    } finally {
      await app.close();
    }
  });

  it('redeploys only the containers that read a saved key', async () => {
    const { app, harness, instanceId } = await appFor();
    try {
      await call(app, 'PUT', '/profiles/stage/settings', {
        expectedInstanceId: instanceId,
        expectedRevision: 0,
        entries: [{ key: 'UPLOADER_START_GATES', value: 'refuse' }],
      });

      const applied = await call(app, 'POST', '/profiles/stage/settings/apply', { expectedInstanceId: instanceId });

      assert.equal(applied.status, 202, JSON.stringify(applied.body));
      assert.deepEqual(applied.body, { recreated: ['stream-uploader'] });
      assert.equal(harness.runner.runs.length, 2);
      assert.ok(harness.runner.runs[1]!.args.includes('stream-uploader'), harness.runner.runs[1]!.args.join(' '));
      assert.equal(harness.runner.runs[1]!.args.includes('srs'), false);
    } finally {
      await app.close();
    }
  });

  it('refuses a stopped deployment, whose Start uses its settings anyway', async () => {
    const { app, instanceId } = await appFor({ status: 'STOPPED' });
    try {
      const refused = await call(app, 'POST', '/profiles/stage/settings/apply', { expectedInstanceId: instanceId });

      assert.equal(refused.status, 409);
      assert.equal((refused.body as { error: string }).error, 'profile_stopped');
    } finally {
      await app.close();
    }
  });
});
