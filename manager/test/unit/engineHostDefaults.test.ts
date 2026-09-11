/**
 * What the engine routes call a default when the host has already set one.
 *
 * Unit test: the real Express wiring on a random port, the profile repository
 * in memory, a scratch stack root standing in for the deploy server's.
 *
 * The base `.env` here sets `HLS_FRAGMENT=2`. `.env.<profile>` is a fresh copy
 * of that file on every deploy and an unset key is left out of it, so 2 seconds
 * is what the container starts with. Both things that read a default have to
 * agree with it: the drawer, which names the number on screen, and the keyframe
 * rule, which multiplies it by the frame rate and refuses the pair the engine
 * would refuse.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { EngineOverview } from '@streaming-infra-manager/common';
import { throwawayRoot } from '../support/throwawayRoot.js';

// SUBMODULE is resolved when envUtils loads and ProfileService reads the base
// env through it, so the root is set before anything importing it is loaded.
const root = throwawayRoot('engine-host-defaults-');
process.env.SHLS_ROOT = root;
writeFileSync(
  join(root, '.env'),
  'ENGINE=srs\nHLS_FRAGMENT=2\nAPI_PORT=10000\n',
  'utf8',
);

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
type RecordedDeploy = { name: string; services: string[] | undefined };

const PUBLISHERS = '1080p@http://10.0.0.1:1633<' + 'a'.repeat(64) + '>';

async function abrApp(): Promise<{
  app: EngineTestApp;
  deploys: RecordedDeploy[];
}> {
  const { service, deploys } = harnessFor(
    profileRow({ kind: 'abr-uploader', bee_publishers: PUBLISHERS }),
  );
  const app = await startEngineTestApp(
    service,
    new ContainerControl(new EventBus(), fakeDocker([])),
  );
  return { app, deploys };
}

describe('GET /profiles/:name/engine with a host default', () => {
  let app: EngineTestApp;

  before(async () => {
    ({ app } = await abrApp());
  });
  after(() => app.close());

  it('answers the host value, and says the host set it', async () => {
    const res = await callEngine(app, 'GET', '/profiles/stream1/engine');
    const overview = res.body as EngineOverview;

    assert.equal(res.status, 200);
    assert.equal(overview.defaults.HLS_FRAGMENT, '2');
    assert.equal(overview.defaultSources.HLS_FRAGMENT, 'host');
  });

  it('leaves every key the base env does not set on the stack value', async () => {
    const res = await callEngine(app, 'GET', '/profiles/stream1/engine');
    const overview = res.body as EngineOverview;

    assert.equal(overview.defaults.HLS_WINDOW, '22.5');
    assert.equal(overview.defaultSources.HLS_WINDOW, 'stack');
  });
});

describe('PUT /profiles/:name/engine-settings against a host default', () => {
  let accepting: EngineTestApp;
  let acceptingDeploys: RecordedDeploy[];
  let refusing: EngineTestApp;
  let refusingDeploys: RecordedDeploy[];

  before(async () => {
    ({ app: accepting, deploys: acceptingDeploys } = await abrApp());
    ({ app: refusing, deploys: refusingDeploys } = await abrApp());
  });
  after(async () => {
    await accepting.close();
    await refusing.close();
  });

  it('accepts a frame rate the stack default would refuse', async () => {
    // 25 frames a second is 37.5 frames against the stack's 1.5 second segment
    // and 50 against this host's 2 second one, so only one of the two answers
    // what the engine would do with it.
    const res = await callEngine(
      accepting,
      'PUT',
      '/profiles/stream1/engine-settings',
      { ABR_FPS: '25' },
    );

    assert.equal(res.status, 202);
    assert.deepEqual(acceptingDeploys, [{ name: 'stream1', services: ['srs'] }]);
  });

  it('still refuses a pair that is not whole against the host value', async () => {
    const res = await callEngine(
      refusing,
      'PUT',
      '/profiles/stream1/engine-settings',
      { ABR_FPS: '25', HLS_FRAGMENT: '1.5' },
    );

    assert.equal(res.status, 400);
    assert.deepEqual(refusingDeploys, []);
    assert.match(
      JSON.stringify(res.body),
      /37\.5 frames, which is not a whole number/,
    );
  });
});
