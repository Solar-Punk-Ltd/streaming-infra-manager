/**
 * A deployment's engine settings, saved and applied through its settings page
 * beside every other key (Levi, 2026-09-26: the Engine card's drawer goes, its
 * settings edited in the same editor).
 *
 * Unit test through the real routes, the real service and an orchestrator over
 * in-memory rows, with a runner that spawns nothing. `pnpm test` in manager/.
 *
 * The engine settings stay where they always were: a save puts an engine key in
 * the engine settings and never in the stack settings, holds it to the
 * engine's own rules with this host's defaults for the half of a pair nothing
 * stores, and moves one revision for the whole save. It recreates nothing.
 * Apply then recreates what the containers are behind on: the engine for an
 * engine key, and the uploader with it for the one the uploader reads too.
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { DeploymentSettingEntry, DeploymentSettingsCatalog } from '@streaming-infra-manager/common';
import { Router } from 'express';

import type { SessionInfo } from '../../src/domain/auth/AuthService.js';
import type { Profile } from '../../src/types/index.js';
import { makeProfile } from '../support/profileFixtures.js';
import { throwawayRoot } from '../support/throwawayRoot.js';

const root = throwawayRoot('deployment-settings-engine-');
process.env.SHLS_ROOT = root;
// The host's own segment length and ceiling, which are what an unset half of the pair falls back to here.
const HOST_ENV = 'ENGINE=srs\nLOG_LEVEL=debug\nHLS_FRAGMENT=0.5\nHLS_SEGMENT_MAX=1\n';
const hostEnvPath = join(root, '.env');
writeFileSync(hostEnvPath, HOST_ENV, 'utf8');
writeFileSync(join(root, '.env.sample'), '# === Stream Uploader ===\nLOG_LEVEL=debug\n', 'utf8');
mkdirSync(join(root, 'engines', 'srs'), { recursive: true });
writeFileSync(join(root, 'engines', 'srs', '.env.sample'), '# === ABR ladder ===\nABR_FPS=30\n', 'utf8');

const { orchestratorHarness, untilRunning } = await import('../support/orchestratorHarness.js');
const { createDeploymentSettingsRouter } = await import('../../src/api/routes/deploymentSettings.js');
const { DeploymentSettingsService } = await import('../../src/domain/settings/DeploymentSettingsService.js');
const { call, startRouterTestApp } = await import('../support/routerTestApp.js');

const INSTANCE_ID = '6f1c2b1e-3a4d-4c5e-9f60-7a8b9c0d1e2f';

function sessionFor(username: string): SessionInfo {
  return { user: { id: 1, username, isAdmin: false }, tokenHash: 'not-a-token', expiresAt: new Date(Date.now() + 60_000) };
}

/** A running deployment, SRS unless told otherwise, deployed once so each container has a record to compare with. */
async function running(over: Partial<Profile> = {}) {
  const harness = orchestratorHarness([makeProfile({ name: 'stage', stamp_id: 'a'.repeat(64), instance_id: INSTANCE_ID, ...over })]);
  await harness.orchestrator.startDeploy(harness.profiles.rows.get('stage')!, undefined);
  harness.runner.finish(0);
  await untilRunning(harness.profiles, 'stage');
  const service = new DeploymentSettingsService(harness.profiles.asRepository(), harness.containers.asRepository(),
    harness.orchestrator, harness.versions);
  const outer = Router();
  const session = sessionFor('operator');
  outer.use((req, _res, next) => {
    req.authSession = session;
    req.user = session.user;
    next();
  });
  outer.use(createDeploymentSettingsRouter(service));
  return { app: await startRouterTestApp(outer), harness };
}

type App = Awaited<ReturnType<typeof running>>['app'];

function save(app: App, expectedRevision: number, entries: { key: string; value: string | null }[]) {
  return call(app, 'PUT', '/profiles/stage/settings', { expectedInstanceId: INSTANCE_ID, expectedRevision, entries });
}

async function listed(app: App): Promise<DeploymentSettingsCatalog> {
  const answered = await call(app, 'GET', '/profiles/stage/settings');
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  return answered.body as DeploymentSettingsCatalog;
}

function entryOf(catalog: DeploymentSettingsCatalog, key: string): DeploymentSettingEntry {
  const entry = catalog.entries.find((candidate) => candidate.key === key);
  assert.ok(entry, `${key} is listed`);
  return entry;
}

describe('saving an engine setting from the settings page', () => {
  it('stores it in the engine settings and never in the stack settings, and restarts nothing', async () => {
    const { app, harness } = await running();
    try {
      const saved = await save(app, 0, [{ key: 'HLS_WINDOW', value: '20' }]);

      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.deepEqual(saved.body, { revision: 1 });
      assert.deepEqual(harness.profiles.rows.get('stage')!.engine_settings, { HLS_WINDOW: '20' });
      assert.deepEqual(harness.profiles.stackSettings.get('stage') ?? {}, {});
      assert.equal(harness.runner.runs.length, 1, 'only the first deploy ran');
      const entry = entryOf(await listed(app), 'HLS_WINDOW');
      assert.deepEqual({ source: entry.source, storedValue: entry.storedValue }, { source: 'deployment', storedValue: '20' });
    } finally {
      await app.close();
    }
  });

  it('refuses a value outside its field, naming the key, and stores nothing', async () => {
    const { app, harness } = await running();
    try {
      const refused = await save(app, 0, [{ key: 'HLS_FRAGMENT', value: '0.1' }]);

      assert.equal(refused.status, 400);
      assert.deepEqual(refused.body, {
        error: 'validation_error',
        errors: ['HLS_FRAGMENT: Segment length must be at least 0.5. Got 0.1.'],
        name: 'stage',
      });
      assert.deepEqual(harness.profiles.rows.get('stage')!.engine_settings, {});
      assert.equal(harness.profiles.settingsRevisions.get('stage') ?? 0, 0);
    } finally {
      await app.close();
    }
  });

  it("refuses a pair the engine would refuse, judged with this host's default for the half nothing stores", async () => {
    const { app, harness } = await running();
    try {
      // 1.5 seconds is under the 2.5 second ceiling every stack falls back to, and over this host's own 1.
      const refused = await save(app, 0, [{ key: 'HLS_FRAGMENT', value: '1.5' }]);

      assert.equal(refused.status, 400);
      assert.match(
        (refused.body as { errors: string[] }).errors.join(' '),
        /^The force-close ceiling of 1 seconds is below the segment length of 1\.5 seconds/,
      );
      assert.deepEqual(harness.profiles.rows.get('stage')!.engine_settings, {});
    } finally {
      await app.close();
    }
  });

  it('refuses a value for a rung setting on a deployment that does not encode the ladder', async () => {
    const { app } = await running();
    try {
      const refused = await save(app, 0, [{ key: 'ABR_FPS', value: '25' }]);

      assert.equal(refused.status, 400);
      assert.deepEqual((refused.body as { errors: string[] }).errors, [
        'ABR_FPS cannot be set here, because only a deployment that encodes the ABR ladder reads it.',
      ]);
    } finally {
      await app.close();
    }
  });

  it('takes a reset back out of the engine settings', async () => {
    const { app, harness } = await running();
    try {
      await save(app, 0, [{ key: 'HLS_WINDOW', value: '20' }]);

      const reset = await save(app, 1, [{ key: 'HLS_WINDOW', value: null }]);

      assert.equal(reset.status, 200, JSON.stringify(reset.body));
      assert.deepEqual(reset.body, { revision: 2 });
      assert.deepEqual(harness.profiles.rows.get('stage')!.engine_settings, {});
      assert.equal(entryOf(await listed(app), 'HLS_WINDOW').source, 'version');
    } finally {
      await app.close();
    }
  });

  it('stores a stack key and an engine key of one save under one revision', async () => {
    const { app, harness } = await running();
    try {
      const saved = await save(app, 0, [{ key: 'LOG_LEVEL', value: 'warn' }, { key: 'SRT_LATENCY', value: '3000' }]);

      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.deepEqual(saved.body, { revision: 1 });
      assert.deepEqual(harness.profiles.stackSettings.get('stage'), { LOG_LEVEL: 'warn' });
      assert.deepEqual(harness.profiles.rows.get('stage')!.engine_settings, { SRT_LATENCY: '3000' });
    } finally {
      await app.close();
    }
  });

  it('refuses a save made against an older revision, engine keys and all', async () => {
    const { app, harness } = await running();
    try {
      await save(app, 0, [{ key: 'LOG_LEVEL', value: 'warn' }]);

      const late = await save(app, 0, [{ key: 'HLS_WINDOW', value: '20' }]);

      assert.equal(late.status, 409);
      assert.equal((late.body as { error: string }).error, 'deployment_settings_changed');
      assert.deepEqual(harness.profiles.rows.get('stage')!.engine_settings, {});
    } finally {
      await app.close();
    }
  });
});

describe('applying a saved engine setting', () => {
  async function applied(key: string, value: string, over: Partial<Profile> = {}) {
    const { app, harness } = await running(over);
    try {
      assert.equal((await save(app, 0, [{ key, value }])).status, 200);
      const behind = (await listed(app)).drift;
      const answer = await call(app, 'POST', '/profiles/stage/settings/apply', { expectedInstanceId: INSTANCE_ID });
      return { behind, answer, run: harness.runner.runs.at(-1)!.args };
    } finally {
      await app.close();
    }
  }

  it('recreates the engine alone for the SRT latency, which only the engine reads', async () => {
    const { behind, answer, run } = await applied('SRT_LATENCY', '3000');

    assert.deepEqual(behind, { keys: ['SRT_LATENCY'], services: ['srs'], fullRedeploy: false });
    assert.equal(answer.status, 202, JSON.stringify(answer.body));
    assert.deepEqual(answer.body, { recreated: ['srs'] });
    assert.ok(run.includes('srs'), run.join(' '));
    assert.equal(run.includes('stream-uploader'), false, run.join(' '));
  });

  it('recreates the engine and the uploader for the segment length, which both read', async () => {
    const { behind, answer, run } = await applied('HLS_FRAGMENT', '1');

    assert.deepEqual(behind, { keys: ['HLS_FRAGMENT'], services: ['srs', 'stream-uploader'], fullRedeploy: false });
    assert.deepEqual(answer.body, { recreated: ['srs', 'stream-uploader'] });
    assert.ok(run.includes('srs') && run.includes('stream-uploader'), run.join(' '));
  });

  // Compose hands the poll interval to the uploader alone, so the engine keeps
  // running: the engine settings route recreated both, and Apply recreates
  // only the container that reads it.
  it('recreates the uploader alone for the OvenMediaEngine poll interval, which only the uploader reads', async () => {
    const ome = { kind: 'custom' as const, components: ['ome', 'stream-uploader', 'bee-uploader'] };
    const { behind, answer, run } = await applied('OME_HLS_POLL_INTERVAL_MS', '250', ome);

    assert.deepEqual(behind, { keys: ['OME_HLS_POLL_INTERVAL_MS'], services: ['stream-uploader'], fullRedeploy: false });
    assert.deepEqual(answer.body, { recreated: ['stream-uploader'] });
    assert.ok(run.includes('stream-uploader'), run.join(' '));
    assert.equal(run.includes('ome'), false, run.join(' '));
  });
});

// A change to the version's .env is enough to get here: the host's ceiling
// drops under a segment length the deployment saved while the host still took
// it. The deploy refuses such settings, and the page is the way to fix them, so
// the list, a save and Apply have to keep answering.
describe('engine settings this host no longer takes', () => {
  const CEILING_UNDER_THE_SAVED_SEGMENT = HOST_ENV.replace('HLS_SEGMENT_MAX=1', 'HLS_SEGMENT_MAX=0.5');
  const REFUSED =
    'The force-close ceiling of 0.5 seconds is below the segment length of 1 seconds, so every piece would be cut ' +
    'before a keyframe could end one and the engine refuses to start. Raise the ceiling to at least the segment ' +
    'length, or lower the segment length.';

  afterEach(() => writeFileSync(hostEnvPath, HOST_ENV, 'utf8'));

  /** A running deployment that saved a segment length of 1, on a host whose ceiling then dropped to 0.5. */
  async function refusedByThisHost() {
    const deployment = await running();
    assert.equal((await save(deployment.app, 0, [{ key: 'HLS_FRAGMENT', value: '1' }])).status, 200);
    writeFileSync(hostEnvPath, CEILING_UNDER_THE_SAVED_SEGMENT, 'utf8');
    return deployment;
  }

  it('lists them with the sentence the deploy refuses them with, and the value it would write', async () => {
    const { app } = await refusedByThisHost();
    try {
      const catalog = await listed(app);

      assert.equal(catalog.engineSettingsProblem, REFUSED);
      assert.equal(entryOf(catalog, 'HLS_FRAGMENT').value, '1');
    } finally {
      await app.close();
    }
  });

  it('stores a save that fixes them, which clears the sentence', async () => {
    const { app, harness } = await refusedByThisHost();
    try {
      const fixed = await save(app, 1, [{ key: 'HLS_FRAGMENT', value: '0.5' }]);

      assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
      assert.deepEqual(harness.profiles.rows.get('stage')!.engine_settings, { HLS_FRAGMENT: '0.5' });
      assert.equal((await listed(app)).engineSettingsProblem, null);
    } finally {
      await app.close();
    }
  });

  it('stores a save of a stack key alone while they wait for a fix', async () => {
    const { app, harness } = await refusedByThisHost();
    try {
      const saved = await save(app, 1, [{ key: 'LOG_LEVEL', value: 'warn' }]);

      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.deepEqual(harness.profiles.stackSettings.get('stage'), { LOG_LEVEL: 'warn' });
      assert.equal((await listed(app)).engineSettingsProblem, REFUSED);
    } finally {
      await app.close();
    }
  });

  it('refuses Apply with that sentence, and deploys nothing', async () => {
    const { app, harness } = await refusedByThisHost();
    try {
      const refused = await call(app, 'POST', '/profiles/stage/settings/apply', { expectedInstanceId: INSTANCE_ID });

      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.deepEqual(refused.body, { error: 'validation_error', errors: [REFUSED], name: 'stage' });
      assert.equal(harness.runner.runs.length, 1, 'only the first deploy ran');
    } finally {
      await app.close();
    }
  });

  it('leaves the deploy refusing them, as it always has', async () => {
    const { app, harness } = await refusedByThisHost();
    try {
      await assert.rejects(harness.orchestrator.startDeploy(harness.profiles.rows.get('stage')!, undefined), {
        message: `refusing to write the engine settings to the env file: ${REFUSED}`,
      });
    } finally {
      await app.close();
    }
  });
});
