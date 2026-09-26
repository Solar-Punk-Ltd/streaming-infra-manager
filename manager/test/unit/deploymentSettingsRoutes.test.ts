/**
 * The three routes of a deployment's own settings, and the list a deployment
 * not made yet is created from, through the real service, an orchestrator over
 * in-memory rows, and a runner that spawns nothing.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/.
 *
 * A save stores and changes nothing that runs. The list then says which
 * settings the running containers are behind on, and Apply redeploys only the
 * containers that read them. What is refused is refused with a status and a
 * sentence an operator can act on, and nothing answered carries a secret.
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { DeploymentSettingsCatalog, NewDeploymentSettingsCatalog } from '@streaming-infra-manager/common';
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
    harness.versions,
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
  it('lists the version keys and the engine settings with nothing behind straight after a deploy, and is not cached', async () => {
    const { app } = await appFor();
    try {
      const response = await fetch(`${app.url}/profiles/stage/settings`);
      const catalog = (await response.json()) as DeploymentSettingsCatalog;

      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(catalog.entries.map((entry) => entry.key), [
        'LOG_LEVEL', 'ADMIN_API_TOKEN', 'UPLOADER_START_GATES', 'STAMP',
        'HLS_FRAGMENT', 'HLS_SEGMENT_MAX', 'HLS_WINDOW', 'SRT_LATENCY',
      ]);
      assert.deepEqual({ engine: catalog.engine, abr: catalog.abr }, { engine: 'srs', abr: false });
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

const ENGINE_SAMPLES: Readonly<Record<string, string>> = {
  srs: 'HLS_FRAGMENT=\nSRS_LOG_TANK=console\n',
  ome: 'OME_ADMISSION_FAIL_OPEN=false\n',
};

/** Engine samples in the version's tree, which the test that writes them takes out again. */
function writeEngineSamples(): void {
  for (const [engine, sample] of Object.entries(ENGINE_SAMPLES)) {
    mkdirSync(join(root, 'engines', engine), { recursive: true });
    writeFileSync(join(root, 'engines', engine, '.env.sample'), sample, 'utf8');
  }
}

async function newDeploymentList(app: Awaited<ReturnType<typeof startRouterTestApp>>, query: string): Promise<NewDeploymentSettingsCatalog> {
  const answered = await call(app, 'GET', `/versions/1/settings-catalog${query}`);
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  return answered.body as NewDeploymentSettingsCatalog;
}

describe('GET /versions/:id/settings-catalog', () => {
  it('lists what a deployment not made yet starts with, stores nothing and is not cached', async () => {
    const { app, harness } = await appFor();
    try {
      const response = await fetch(`${app.url}/versions/1/settings-catalog?kind=streamer`);
      const catalog = (await response.json()) as NewDeploymentSettingsCatalog;

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(catalog.versionId, 1);
      assert.deepEqual(catalog.entries.map((entry) => entry.key), ['LOG_LEVEL', 'ADMIN_API_TOKEN', 'UPLOADER_START_GATES', 'STAMP']);
      assert.deepEqual(catalog.entries.map((entry) => [entry.stored, entry.running]), [
        [false, 'not-running'], [false, 'not-running'], [false, 'not-running'], [false, 'not-running'],
      ]);
      const stamp = catalog.entries.find((entry) => entry.key === 'STAMP');
      assert.deepEqual({ owner: stamp?.owner, value: stamp?.value }, { owner: 'stamp', value: null });
      assert.equal(harness.profiles.rows.size, 1, 'nothing was created');
    } finally {
      await app.close();
    }
  });

  it('takes the engine sample of the engine the components select', async () => {
    const { app } = await appFor();
    writeEngineSamples();
    try {
      const srs = await newDeploymentList(app, '?kind=streamer');
      const ome = await newDeploymentList(app, '?kind=custom&components=ome,stream-uploader');

      assert.deepEqual(srs.entries.slice(4).map((entry) => entry.key), ['HLS_FRAGMENT', 'SRS_LOG_TANK']);
      assert.deepEqual(ome.entries.slice(4).map((entry) => entry.key), ['OME_ADMISSION_FAIL_OPEN']);
    } finally {
      rmSync(join(root, 'engines'), { recursive: true, force: true });
      await app.close();
    }
  });

  it('decides the data directories by the host the deployment would run on', async () => {
    const { app } = await appFor();
    writeFileSync(join(root, '.env.sample'), 'BEE_UPLOADER_DATA_DIR=\n', 'utf8');
    try {
      const here = await newDeploymentList(app, '?kind=streamer');
      const elsewhere = await newDeploymentList(app, '?kind=streamer&host=deploy@edge-1');

      assert.equal(here.entries[0]?.owner, 'data-dir');
      assert.equal(elsewhere.entries[0]?.owner, null);
    } finally {
      await app.close();
    }
  });

  it('never answers a secret the version sets', async () => {
    const { app } = await appFor();
    writeFileSync(join(root, '.env'), `ENGINE=srs\nLOG_LEVEL=debug\nADMIN_API_TOKEN=${SECRET}\n`, 'utf8');
    try {
      const answered = await call(app, 'GET', '/versions/1/settings-catalog?kind=streamer');
      const token = (answered.body as NewDeploymentSettingsCatalog).entries.find((entry) => entry.key === 'ADMIN_API_TOKEN');

      assert.equal(answered.status, 200);
      assert.deepEqual({ versionSet: token?.versionSet, versionValue: token?.versionValue, value: token?.value }, {
        versionSet: true,
        versionValue: null,
        value: null,
      });
      assert.doesNotMatch(JSON.stringify(answered.body), new RegExp(SECRET));
    } finally {
      await app.close();
    }
  });

  it('refuses a version with no build to read the settings from', async () => {
    const { app, harness } = await appFor();
    const candidate = await harness.versions.insert({ name: 'candidate', gitRef: 'main', rootPath: join(root, 'candidate') });
    // Published under the builds layout, and its build has not landed.
    Object.assign(candidate, { layout: 'builds', status: 'ready', buildId: null });
    try {
      const refused = await call(app, 'GET', `/versions/${candidate.id}/settings-catalog?kind=streamer`);

      assert.equal(refused.status, 409);
      assert.equal((refused.body as { error: string }).error, 'settings_not_ready');
    } finally {
      await app.close();
    }
  });

  it('answers 404 for a version that does not exist', async () => {
    const { app } = await appFor();
    try {
      const missing = await call(app, 'GET', '/versions/99/settings-catalog?kind=streamer');

      assert.equal(missing.status, 404);
      assert.equal((missing.body as { error: string }).error, 'stack_version_not_found');
    } finally {
      await app.close();
    }
  });

  it('refuses a deployment no create body could describe', async () => {
    const { app } = await appFor();
    try {
      const twoEngines = await call(app, 'GET', '/versions/1/settings-catalog?kind=custom&components=srs,ome');
      const unknownKind = await call(app, 'GET', '/versions/1/settings-catalog?kind=broadcaster');
      const unknownService = await call(app, 'GET', '/versions/1/settings-catalog?kind=custom&components=srs,teapot');
      const badHost = await call(app, 'GET', '/versions/1/settings-catalog?kind=custom&host=bad%20host');

      for (const refused of [twoEngines, unknownKind, unknownService, badHost]) {
        assert.equal(refused.status, 400, JSON.stringify(refused.body));
        assert.equal((refused.body as { error: string }).error, 'validation_error');
      }
    } finally {
      await app.close();
    }
  });
});
