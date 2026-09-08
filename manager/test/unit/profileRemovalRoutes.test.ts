import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, it } from 'node:test';

import { createProfilesRouter } from '../../src/api/routes/profiles.js';
import type { ProfileService } from '../../src/domain/ProfileService.js';
import { call, startRouterTestApp, type RouterTestApp } from '../support/routerTestApp.js';

let app: RouterTestApp;
let calls: unknown[][];
beforeEach(async () => {
  calls = [];
  const service = { remove: async (...args: unknown[]) => { calls.push(args); return { name: args[0], status: 'REMOVING' }; } };
  app = await startRouterTestApp(createProfilesRouter(service as unknown as ProfileService), '/profiles');
});
afterEach(async () => { await app?.close(); });

it('passes the exact expected deployment instance into removal', async () => {
  const expectedInstanceId = randomUUID();
  assert.equal((await call(app, 'DELETE', '/profiles/owned', { expectedInstanceId })).status, 202);
  assert.deepEqual(calls, [['owned', { expectedInstanceId }]]);
});

for (const expectedInstanceId of ['', 'not-an-instance', null, 1, {}]) {
  it(`rejects an invalid removal identity ${JSON.stringify(expectedInstanceId)} before service work`, async () => {
    assert.equal((await call(app, 'DELETE', '/profiles/owned', { expectedInstanceId })).status, 400);
    assert.deepEqual(calls, []);
  });
}

it('keeps an omitted precondition compatible with existing removal callers', async () => {
  assert.equal((await call(app, 'DELETE', '/profiles/owned')).status, 202);
  assert.equal(calls.length, 1);
});
