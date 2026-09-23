/**
 * The SRT latency as an engine setting of one deployment.
 *
 * Unit test: the real Express wiring on a random port, the profile repository
 * in memory, a scratch stack root standing in for the deploy server's.
 *
 * SRS waits this long for a lost SRT packet to be resent before it gives up on
 * the packet, and a packet given up on is a hole in a video frame. On
 * 2026-09-22 an outside broadcaster lost 5 to 8.5% of its packets, nearly all
 * were resent, and SRS dropped the resends as too late at its own 120 ms, where
 * the stack asked for 200. Until 2026-09-23 the manager showed the stack's
 * number and let nobody change it.
 * Since then it is a setting, and a deployment that stores none gets the
 * owner's 2000 unless the host sets a value of its own.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  type EngineOverview,
  SRS_SERVICE,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';
import { throwawayRoot } from '../support/throwawayRoot.js';

// envUtils reads SHLS_ROOT once when it loads, and ProfileService reads the
// base env through it, so the root is set before anything reaching it loads.
const root = throwawayRoot('srt-latency-');
process.env.SHLS_ROOT = root;
const BASE_ENV = 'ENGINE=srs\nAPI_PORT=10000\n';
writeFileSync(join(root, '.env'), BASE_ENV, 'utf8');

const { ContainerControl } = await import('../../src/domain/ContainerControl.js');
const { EventBus } = await import('../../src/domain/EventBus.js');
const { SERVICE_ENV_KEYS } = await import('../../src/domain/containerKeysSpec.js');
const { ALLOCATION_CONTRACT } = await import('../support/allocationContract.js');
const { callEngine, startEngineTestApp } = await import('../support/engineTestApp.js');
const { fakeDocker } = await import('../support/fakeDocker.js');
const { orchestratorHarness, untilRunning } = await import('../support/orchestratorHarness.js');
const { makeProfile } = await import('../support/profileFixtures.js');
const { harnessFor, profileRow, profileServiceHarness } = await import('../support/profileServiceHarness.js');

type EngineTestApp = Awaited<ReturnType<typeof startEngineTestApp>>;
type Harness = ReturnType<typeof harnessFor>;

async function engineApp(): Promise<{ app: EngineTestApp; harness: Harness }> {
  const harness = harnessFor(profileRow());
  const app = await startEngineTestApp(
    harness.service,
    new ContainerControl(new EventBus(), fakeDocker([])),
  );
  return { app, harness };
}

describe('PUT /profiles/:name/engine-settings with an SRT latency', () => {
  let accepting: { app: EngineTestApp; harness: Harness };
  let refusing: { app: EngineTestApp; harness: Harness };

  before(async () => {
    accepting = await engineApp();
    refusing = await engineApp();
  });
  after(async () => {
    await accepting.app.close();
    await refusing.app.close();
  });

  it('stores it and recreates the engine that reads it', async () => {
    const res = await callEngine(
      accepting.app,
      'PUT',
      '/profiles/stream1/engine-settings',
      { SRT_LATENCY: '3000' },
    );

    assert.equal(res.status, 202);
    assert.deepEqual(accepting.harness.stored().engine_settings, { SRT_LATENCY: '3000' });
    assert.deepEqual(accepting.harness.deploys, [{ name: 'stream1', services: [SRS_SERVICE] }]);
  });

  it('refuses a value outside the bounds, and starts nothing', async () => {
    const res = await callEngine(
      refusing.app,
      'PUT',
      '/profiles/stream1/engine-settings',
      { SRT_LATENCY: '20000' },
    );

    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body), /SRT latency must be at most 10000/);
    assert.deepEqual(refusing.harness.deploys, []);
    assert.deepEqual(refusing.harness.stored().engine_settings, {});
  });
});

describe('GET /profiles/:name/engine for an SRS deployment', () => {
  it('offers the SRT latency beside the segment settings', async () => {
    const { app } = await engineApp();
    try {
      const overview = (await callEngine(app, 'GET', '/profiles/stream1/engine'))
        .body as EngineOverview;

      const field = overview.fields.find((candidate) => candidate.key === 'SRT_LATENCY');
      assert.ok(field, 'the drawer is handed no SRT latency field');
      assert.equal(field.unit, 'milliseconds');
    } finally {
      await app.close();
    }
  });
});

describe('the container snapshot of an SRS deployment', () => {
  it('records the SRT latency against the engine, and not against the uploader', () => {
    assert.ok((SERVICE_ENV_KEYS[SRS_SERVICE] ?? []).includes('SRT_LATENCY'));
    assert.equal((SERVICE_ENV_KEYS[STREAM_UPLOADER_SERVICE] ?? []).includes('SRT_LATENCY'), false);
  });
});

/**
 * A deploy, from the stored row to the file compose reads and the snapshot a
 * page shows, on a version that falls back to 200 the way v3.1 does.
 */
describe('what a deploy hands SRS for the SRT latency', () => {
  async function deployed(
    name: string,
    baseEnv: string,
    engineSettings: Record<string, string> = {},
  ): Promise<{ file: string; snapshot: Record<string, string> | undefined }> {
    writeFileSync(join(root, '.env'), baseEnv, 'utf8');
    const stored = makeProfile({ name, stamp_id: 'a'.repeat(64), engine_settings: engineSettings });
    const harness = orchestratorHarness([stored]);
    await harness.versions.setContract(1, {
      ...structuredClone(ALLOCATION_CONTRACT),
      engineDefaults: { SRT_LATENCY: '200' },
    });

    await harness.orchestrator.startDeploy(stored, [SRS_SERVICE]);
    harness.runner.finish(0);
    await untilRunning(harness.profiles, name);

    return {
      file: readFileSync(join(root, `.env.${name}`), 'utf8'),
      snapshot: harness.containers.snapshots.find((entry) => entry.service === SRS_SERVICE)?.env,
    };
  }

  after(() => writeFileSync(join(root, '.env'), BASE_ENV, 'utf8'));

  it("hands SRS the manager's 2000 ms, and the snapshot says so", async () => {
    const { file, snapshot } = await deployed('latency-default', BASE_ENV);

    assert.match(file, /^SRT_LATENCY=2000$/m);
    assert.equal(snapshot?.SRT_LATENCY, '2000');
  });

  it('hands SRS the value set on the host instead, and the snapshot agrees', async () => {
    const { file, snapshot } = await deployed('latency-host', `${BASE_ENV}SRT_LATENCY=500\n`);

    assert.match(file, /^SRT_LATENCY=500$/m);
    assert.equal(snapshot?.SRT_LATENCY, '500');
  });

  it('hands SRS what the deployment stored over both', async () => {
    const { file, snapshot } = await deployed(
      'latency-stored',
      `${BASE_ENV}SRT_LATENCY=500\n`,
      { SRT_LATENCY: '3000' },
    );

    assert.match(file, /^SRT_LATENCY=3000$/m);
    assert.equal(snapshot?.SRT_LATENCY, '3000');
  });
});

/**
 * A deployment running a config file of its own, read against the stack's
 * template since a1b43f0a. SRS waits `recvlatency` on ingest and falls back to
 * 120 without it, whatever `latency` says.
 */
describe('GET /profiles/:name/engine for a deployment with a config file of its own', () => {
  const FIXED_SRS_TEMPLATE = 'srt_server {\n    enabled on;\n    latency SRT_LATENCY_PLACEHOLDER;\n    recvlatency SRT_LATENCY_PLACEHOLDER;\n}\n';

  before(() => {
    mkdirSync(join(root, 'engines', 'srs'), { recursive: true });
    writeFileSync(join(root, 'engines', 'srs', 'srs.conf.template'), FIXED_SRS_TEMPLATE, 'utf8');
  });

  async function overviewOf(config: string): Promise<EngineOverview> {
    const harness = profileServiceHarness([
      profileRow({ has_engine_config: true, engine_settings: { SRT_LATENCY: '3000' } }),
    ]);
    harness.profiles.engineConfigs.set('stream1', config);
    const app = await startEngineTestApp(
      harness.service,
      new ContainerControl(new EventBus(), fakeDocker([])),
    );
    try {
      return (await callEngine(app, 'GET', '/profiles/stream1/engine')).body as EngineOverview;
    } finally {
      await app.close();
    }
  }

  it("shows SRS's own 120 for a file that sets latency and no recvlatency, and says why", async () => {
    const overview = await overviewOf('srt_server {\n    enabled on;\n    latency SRT_LATENCY_PLACEHOLDER;\n}\n');

    assert.equal(overview.effective.SRT_LATENCY, '120', 'not the stored 3000, which SRS never applies here');
    assert.deepEqual(overview.observations.SRT_LATENCY, {
      status: 'known', source: 'built-in', value: '120', environment: 'none', reason: 'latency-without-recvlatency',
    });
    assert.ok(overview.notInConfig.includes('SRT_LATENCY'));
  });

  it('shows the stored value for a file that keeps the recvlatency placeholder', async () => {
    const overview = await overviewOf(FIXED_SRS_TEMPLATE);

    assert.equal(overview.effective.SRT_LATENCY, '3000');
    assert.equal(overview.observations.SRT_LATENCY.source, 'deployment');
  });
});
