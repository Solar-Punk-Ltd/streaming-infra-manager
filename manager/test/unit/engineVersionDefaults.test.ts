/**
 * What the engine routes call a default on a version whose entrypoints fall
 * back to other numbers than the pinned one.
 *
 * Unit test: the real Express wiring on a random port, the profile repository
 * in memory, a scratch stack root standing in for the deploy server's.
 *
 * main-v3 cuts 0.5 second segments and keeps 15 seconds of playlist where
 * main-v2 has 1.5 and 22.5. A drawer that names 1.5 to a main-v3 deployment
 * describes a container nobody is running, and the keyframe rule computed with
 * it refuses pairs the engine would start with.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { EngineOverview, StackContract } from '@streaming-infra-manager/common';

const root = mkdtempSync(join(tmpdir(), 'engine-version-defaults-'));
process.env.SHLS_ROOT = root;
writeFileSync(join(root, '.env'), 'ENGINE=srs\nAPI_PORT=10000\n', 'utf8');

const { ContainerControl } = await import(
  '../../src/domain/ContainerControl.js'
);
const { EventBus } = await import('../../src/domain/EventBus.js');
const { callEngine, startEngineTestApp } = await import(
  '../support/engineTestApp.js'
);
const { fakeDocker } = await import('../support/fakeDocker.js');
const { harnessFor, profileRow } = await import(
  '../support/profileServiceHarness.js'
);

type EngineTestApp = Awaited<ReturnType<typeof startEngineTestApp>>;

const V3_CONTRACT: StackContract = {
  ports: [{ name: 'SRS_HTTP_API_PORT', defaultPort: 1985, slotBase: 10009, protocol: 'tcp' }],
  maxSlot: 99,
  requiredSecrets: [],
  engineDefaults: { HLS_FRAGMENT: '0.5', HLS_WINDOW: '15', SRT_LATENCY: '200' },
  features: { srsApiPort: true, chequebookGate: true, sharedImageTags: true },
  chequebookMinBzz: '0.5',
  engineConfig: { srs: true, ome: true },
  engineImages: { srs: 'ossrs/srs:6', ome: null },
  warnings: [],
  allocationProblem: null,
};

describe('GET /profiles/:name/engine on a version with its own defaults', () => {
  let app: EngineTestApp;

  before(async () => {
    const { service, versions } = harnessFor(profileRow());
    // The bundled row stands in for a main-v3 checkout: the contract is what
    // the route reads, and the row's name is not.
    await versions.setContract(1, V3_CONTRACT);
    app = await startEngineTestApp(
      service,
      new ContainerControl(new EventBus(), fakeDocker([])),
    );
  });
  after(() => app.close());

  it("answers the version's fallbacks and calls them the stack's", async () => {
    const res = await callEngine(app, 'GET', '/profiles/stream1/engine');
    const overview = res.body as EngineOverview;

    assert.equal(res.status, 200);
    assert.equal(overview.defaults.HLS_FRAGMENT, '0.5');
    assert.equal(overview.defaults.HLS_WINDOW, '15');
    assert.equal(overview.defaultSources.HLS_WINDOW, 'stack');
  });

  it('says the API port is published but not read, rather than not there', async () => {
    const res = await callEngine(app, 'GET', '/profiles/stream1/engine');
    const overview = res.body as EngineOverview;

    assert.match(overview.liveUnavailableReason, /publishes the SRS API port/);
    assert.equal(overview.live, null);
  });
});
