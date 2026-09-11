import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';

import { createGroupsRouter } from '../../src/api/routes/groups.js';
import type { EmptyGroupRemoval } from '../../src/domain/DeploymentGroupRepository.js';
import { call, startRouterTestApp, type RouterTestApp } from '../support/routerTestApp.js';

process.env.DATABASE_URL = 'postgres://unused';
const { profileServiceHarness } = await import('../support/profileServiceHarness.js');
let app: RouterTestApp;
let calls: unknown[][];
let outcome: EmptyGroupRemoval;
beforeEach(async () => {
  calls = [];
  outcome = 'deleted';
  const harness = profileServiceHarness();
  Object.assign(harness.groups, {
    removeEmptyGroup: async (...args: unknown[]) => { calls.push(args); return outcome; },
    findById: async () => { throw new Error('Cleanup must not read then delete'); },
    listMembers: async () => { throw new Error('Cleanup must not adopt current members'); },
  });
  app = await startRouterTestApp(createGroupsRouter(harness.service), '/groups');
});
afterEach(async () => { await app?.close(); });

for (const result of ['deleted', 'absent'] as const) {
  it(`accepts an atomic ${result} result through the real service`, async () => {
    outcome = result;
    const response = await call(app, 'DELETE', '/groups/42', { expectedName: 'owned' });
    assert.equal(response.status, 204);
    assert.deepEqual(calls, [[42, 'owned']]);
  });
}

for (const result of ['changed', 'not_empty'] as const) {
  it(`reports ${result} without cascading or adopting current members`, async () => {
    outcome = result;
    const response = await call(app, 'DELETE', '/groups/42', { expectedName: 'owned' });
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, { error: `group_${result}`, id: 42 });
    assert.deepEqual(calls, [[42, 'owned']]);
  });
}

for (const body of [undefined, {}, { expectedName: '' }, { expectedName: null }, { expectedName: 12 }, { expectedName: 'bad/name' }, { expectedName: 'owned', cascade: true }]) {
  it(`rejects an invalid ownership body ${JSON.stringify(body)} before repository work`, async () => {
    assert.equal((await call(app, 'DELETE', '/groups/42', body)).status, 400);
    assert.deepEqual(calls, []);
  });
}

for (const id of ['0', '-1', '1.5', '1x', '9007199254740993']) {
  it(`rejects invalid group id ${id} before repository work`, async () => {
    assert.equal((await call(app, 'DELETE', `/groups/${id}`, { expectedName: 'owned' })).status, 400);
    assert.deepEqual(calls, []);
  });
}
