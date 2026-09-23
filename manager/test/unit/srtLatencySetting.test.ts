/**
 * The SRT latency as an engine setting of one deployment.
 *
 * Unit test: the real Express wiring on a random port, the profile repository
 * in memory, a scratch stack root standing in for the deploy server's.
 *
 * SRS waits this long for a lost SRT packet to be resent before it gives up on
 * the packet, and a packet given up on is a hole in a video frame. On
 * 2026-09-22 an outside broadcaster lost 5 to 8.5% of its packets, nearly all
 * were resent, and SRS dropped the resends as too late at the stack's 200 ms.
 * Until 2026-09-23 the manager showed the number and let nobody change it.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
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
writeFileSync(join(root, '.env'), 'ENGINE=srs\nAPI_PORT=10000\n', 'utf8');

const { ContainerControl } = await import('../../src/domain/ContainerControl.js');
const { EventBus } = await import('../../src/domain/EventBus.js');
const { SERVICE_ENV_KEYS } = await import('../../src/domain/containerKeysSpec.js');
const { callEngine, startEngineTestApp } = await import('../support/engineTestApp.js');
const { fakeDocker } = await import('../support/fakeDocker.js');
const { harnessFor, profileRow } = await import('../support/profileServiceHarness.js');

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
