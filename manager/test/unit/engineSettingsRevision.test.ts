/**
 * The engine settings route, which scripts still use to save and recreate in
 * one call, and a deployment's settings page share one revision.
 *
 * Unit test, no database and no deploy script. `pnpm test` in manager/.
 *
 * Both write what a deployment stores, so either save moves the revision the
 * other guards on. A scripted save refuses to write over a page save that
 * landed after it read the settings, and a page that read before a scripted
 * save is refused rather than writing over it. Whichever loses says so, and
 * nothing it would have written is stored.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { Router } from 'express';

import type { SessionInfo } from '../../src/domain/auth/AuthService.js';
import type { DeploymentGroupRepository } from '../../src/domain/DeploymentGroupRepository.js';
import { throwawayRoot } from '../support/throwawayRoot.js';

const root = throwawayRoot('engine-settings-revision-');
process.env.SHLS_ROOT = root;
writeFileSync(join(root, '.env'), 'ENGINE=srs\nLOG_LEVEL=debug\n', 'utf8');
writeFileSync(join(root, '.env.sample'), '# === Stream Uploader ===\nLOG_LEVEL=debug\n', 'utf8');

const { EngineSettingsChangedError } = await import('../../src/domain/errors/index.js');
const { profileRow, profileServiceHarness } = await import('../support/profileServiceHarness.js');
const { orchestratorHarness } = await import('../support/orchestratorHarness.js');
const { makeProfile } = await import('../support/profileFixtures.js');
const { ProfileService } = await import('../../src/domain/ProfileService.js');
const { DeploymentSettingsService } = await import('../../src/domain/settings/DeploymentSettingsService.js');
const { ContainerControl } = await import('../../src/domain/ContainerControl.js');
const { fakeDocker } = await import('../support/fakeDocker.js');
const { createDeploymentSettingsRouter } = await import('../../src/api/routes/deploymentSettings.js');
const { createEngineRouter } = await import('../../src/api/routes/engine.js');
const { call, startRouterTestApp } = await import('../support/routerTestApp.js');

/** A save names the instance as a UUID, which the fixture's own default is not. */
const INSTANCE_ID = '6f1c2b1e-3a4d-4c5e-9f60-7a8b9c0d1e2f';

const LOG_LEVEL_SAVE = { plain: { LOG_LEVEL: 'warn' }, secret: {}, remove: [] };

describe('the engine settings route and the settings revision', () => {
  it('moves the revision a settings page names', async () => {
    const harness = profileServiceHarness([profileRow()]);

    await harness.service.updateEngineSettings('stream1', { HLS_WINDOW: '12' });

    assert.equal(harness.profiles.settingsRevisions.get('stream1'), 1);
  });

  it('refuses to write over a page save that landed after it read the settings, and recreates nothing', async () => {
    const harness = profileServiceHarness([profileRow({ engine_settings: { HLS_WINDOW: '12' } })]);
    const { orchestrator, profiles } = harness;
    const instanceId = profiles.rows.get('stream1')!.instance_id;
    // The gate runs between the route's read and its write, which is where a page save can land.
    orchestrator.gate = async () => {
      await profiles.updateStackSettings('stream1', LOG_LEVEL_SAVE, { instanceId, expectedRevision: 0 });
    };

    await assert.rejects(harness.service.updateEngineSettings('stream1', { HLS_WINDOW: '30' }), EngineSettingsChangedError);

    assert.deepEqual(profiles.rows.get('stream1')!.engine_settings, { HLS_WINDOW: '12' });
    assert.deepEqual(profiles.stackSettings.get('stream1'), { LOG_LEVEL: 'warn' });
    assert.equal(profiles.settingsRevisions.get('stream1'), 1);
    assert.deepEqual(orchestrator.deploys, []);
    assert.deepEqual(orchestrator.cancelled, ['stream1']);
    assert.equal(profiles.statusOf('stream1'), 'RUNNING');
  });
});

function sessionFor(username: string): SessionInfo {
  return { user: { id: 1, username, isAdmin: false }, tokenHash: 'not-a-token', expiresAt: new Date(Date.now() + 60_000) };
}

/** Both routers on one app over the same rows, as `api/server.ts` mounts them behind a session. */
async function bothRoutes() {
  const harness = orchestratorHarness([makeProfile({ name: 'stage', stamp_id: 'a'.repeat(64), instance_id: INSTANCE_ID })]);
  const profiles = new ProfileService(harness.profiles.asRepository(), harness.containers.asRepository(),
    harness.orchestrator, harness.events, {} as DeploymentGroupRepository, harness.versions);
  const settings = new DeploymentSettingsService(harness.profiles.asRepository(), harness.containers.asRepository(),
    harness.orchestrator, harness.versions);
  const outer = Router();
  const session = sessionFor('operator');
  outer.use((req, _res, next) => {
    req.authSession = session;
    req.user = session.user;
    next();
  });
  outer.use(createDeploymentSettingsRouter(settings));
  outer.use(createEngineRouter(profiles, new ContainerControl(harness.events, fakeDocker([])), null));
  return { app: await startRouterTestApp(outer), harness };
}

describe('a page that read before a scripted save', () => {
  it('is refused as changed elsewhere and stores nothing, and the scripted value stands', async () => {
    const { app, harness } = await bothRoutes();
    try {
      const read = await call(app, 'GET', '/profiles/stage/settings');
      assert.equal(read.status, 200, JSON.stringify(read.body));
      const scripted = await call(app, 'PUT', '/profiles/stage/engine-settings', { HLS_WINDOW: '20', expectedInstanceId: INSTANCE_ID });
      assert.equal(scripted.status, 202, JSON.stringify(scripted.body));

      const late = await call(app, 'PUT', '/profiles/stage/settings', {
        expectedInstanceId: INSTANCE_ID,
        expectedRevision: (read.body as { revision: number }).revision,
        entries: [{ key: 'LOG_LEVEL', value: 'warn' }],
      });

      assert.equal(late.status, 409, JSON.stringify(late.body));
      assert.equal((late.body as { error: string }).error, 'deployment_settings_changed');
      assert.equal(harness.profiles.stackSettings.get('stage'), undefined);
      assert.deepEqual(harness.profiles.rows.get('stage')!.engine_settings, { HLS_WINDOW: '20' });
    } finally {
      await app.close();
    }
  });
});
