/**
 * What the engine routes refuse, over HTTP.
 *
 * Unit test: the real Express wiring on a random port, with the profile
 * repository in memory and a fake Docker daemon. `pnpm test` in manager/.
 *
 * A restart while a deploy is running is the case worth holding down. The
 * deploy is already recreating these containers, so bouncing one in the middle
 * of it leaves compose and the daemon disagreeing about what is up, and the
 * status the operator then sees belongs to neither.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_SERVICE_LABEL,
} from '../../src/domain/composeLabels.js';
import { ContainerControl } from '../../src/domain/ContainerControl.js';
import { EventBus } from '../../src/domain/EventBus.js';
import {
  callEngine,
  startEngineTestApp,
  type EngineTestApp,
} from '../support/engineTestApp.js';
import { fakeDocker } from '../support/fakeDocker.js';
import { harnessFor, profileRow } from '../support/profileServiceHarness.js';
import type { ProfileStatus } from '../../src/types/index.js';

const RUNNING_SRS = [
  {
    id: 'own-srs',
    labels: {
      [COMPOSE_PROJECT_LABEL]: 'stream1',
      [COMPOSE_SERVICE_LABEL]: 'srs',
    },
  },
];

async function appFor(status: ProfileStatus): Promise<{
  app: EngineTestApp;
  docker: ReturnType<typeof fakeDocker>;
}> {
  const { service } = harnessFor(profileRow({ status }));
  const docker = fakeDocker(RUNNING_SRS);
  const app = await startEngineTestApp(
    service,
    new ContainerControl(new EventBus(), docker),
  );
  return { app, docker };
}

describe('POST /profiles/:name/containers/:service/restart', () => {
  let deploying: EngineTestApp;
  let deployingDocker: ReturnType<typeof fakeDocker>;
  let running: EngineTestApp;

  before(async () => {
    ({ app: deploying, docker: deployingDocker } = await appFor('DEPLOYING'));
    ({ app: running } = await appFor('RUNNING'));
  });
  after(async () => {
    await deploying.close();
    await running.close();
  });

  it('refuses while the deployment is mid deploy, and touches nothing', async () => {
    const res = await callEngine(
      deploying,
      'POST',
      '/profiles/stream1/containers/srs/restart',
    );

    assert.equal(res.status, 409);
    assert.deepEqual(res.body, {
      error: 'profile_busy',
      name: 'stream1',
      status: 'DEPLOYING',
    });
    assert.deepEqual(deployingDocker.restarted, []);
  });

  it('accepts it once the deployment is settled', async () => {
    const res = await callEngine(
      running,
      'POST',
      '/profiles/stream1/containers/srs/restart',
    );

    assert.equal(res.status, 202);
    assert.deepEqual(res.body, {
      status: 'accepted',
      name: 'stream1',
      service: 'srs',
    });
  });

  it('answers 409 to a second restart a moment later', async () => {
    const res = await callEngine(
      running,
      'POST',
      '/profiles/stream1/containers/srs/restart',
    );

    assert.equal(res.status, 409);
    assert.deepEqual(res.body, {
      error: 'restart_in_progress',
      name: 'stream1',
      service: 'srs',
      message:
        'srs on stream1 was restarted a moment ago. Wait a few seconds, then try again.',
    });
  });
});
