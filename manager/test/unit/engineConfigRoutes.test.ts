/**
 * The two things an operator does with a rollout that did not finish, as
 * routes: verify what is stored again, and go back to the previous file.
 *
 * Unit test, no database and no Docker. `pnpm test` in manager/. The service
 * is stood in for: what is under test is which route reaches which call, and
 * with which status a refusal comes back.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createEngineConfigRouter } from '../../src/api/routes/engineConfig.js';
import type { EngineConfigService } from '../../src/domain/engineConfig/EngineConfigService.js';
import { ProfileBusyError, ProfileConfigError } from '../../src/domain/errors/index.js';
import { call, type RouterTestApp, startRouterTestApp } from '../support/routerTestApp.js';

const calls: string[] = [];

const service = {
  async verifyNow(name: string) {
    calls.push(`verify:${name}`);
    if (name === 'busy') throw new ProfileBusyError(name, 'DEPLOYING');
    return { name, engine_config_state: 'applying' };
  },
  async recreateOnPrevious(name: string) {
    calls.push(`previous:${name}`);
    if (name === 'settled') {
      throw new ProfileConfigError(name, 'There is no interrupted rollout to go back from.');
    }
    return { name, engine_config_state: 'applying' };
  },
} as unknown as EngineConfigService;

let app: RouterTestApp;

before(async () => {
  app = await startRouterTestApp(createEngineConfigRouter(service));
});

after(() => app.close());

describe('POST /profiles/:name/engine-config/verify', () => {
  it('starts a rollout on what is stored and answers 202 with the row', async () => {
    const res = await call(app, 'POST', '/profiles/stream1/engine-config/verify');

    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { name: 'stream1', engine_config_state: 'applying' });
    assert.ok(calls.includes('verify:stream1'));
  });

  it('answers 409 while the deployment is mid transition', async () => {
    const res = await call(app, 'POST', '/profiles/busy/engine-config/verify');

    assert.equal(res.status, 409);
    assert.equal((res.body as { error: string }).error, 'profile_busy');
  });
});

describe('POST /profiles/:name/engine-config/restore-previous', () => {
  it('puts the interrupted rollout\'s previous file back and answers 202 with the row', async () => {
    const res = await call(app, 'POST', '/profiles/stream1/engine-config/restore-previous');

    assert.equal(res.status, 202);
    assert.ok(calls.includes('previous:stream1'));
  });

  it('answers 400 in the service\'s words when no rollout is interrupted', async () => {
    const res = await call(app, 'POST', '/profiles/settled/engine-config/restore-previous');

    assert.equal(res.status, 400);
    assert.deepEqual((res.body as { errors: string[] }).errors, [
      'There is no interrupted rollout to go back from.',
    ]);
  });
});
