import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { it } from 'node:test';

import { createGroupsRouter } from '../../src/api/routes/groups.js';
import { createProfilesRouter } from '../../src/api/routes/profiles.js';
import type { Profile, ProfileWithContainers } from '../../src/types/index.js';
import { call, startRouterTestApp } from '../support/routerTestApp.js';

process.env.DATABASE_URL = 'postgres://unused';
const { profileRow, profileServiceHarness } = await import('../support/profileServiceHarness.js');
type Harness = ReturnType<typeof profileServiceHarness>;

function trackInserted(harness: Harness) {
  const inserted: Profile[] = [];
  const remember = (profiles: Profile[]) => {
    for (const profile of profiles) {
      profile.instance_id = randomUUID();
      inserted.push(structuredClone(profile));
    }
  };
  const create = harness.groups.createGroupWithMembers.bind(harness.groups);
  harness.groups.createGroupWithMembers = async (...args) => {
    const result = await create(...args);
    remember(result.profiles);
    return result;
  };
  const add = harness.groups.addMembers.bind(harness.groups);
  harness.groups.addMembers = async (...args) => {
    const result = await add(...args);
    remember(result);
    return result;
  };
  return inserted;
}

const identities = (rows: readonly Profile[]) => rows.map(row => [row.name, row.instance_id]);

for (const action of ['create', 'resize'] as const) {
  for (const change of ['replaced', 'removed', 'same-instance-error'] as const) {
    it(`${action} returns inserted identities when a member is ${change} during startup`, async () => {
      const harness = profileServiceHarness([profileRow({ name: 'owned-profile-1' })]);
      const inserted = trackInserted(harness);
      harness.orchestrator.runReserved = async (_reservation, profile) => {
        if (change === 'removed') harness.profiles.rows.delete(profile.name);
        else harness.profiles.rows.set(profile.name, { ...profile,
          instance_id: change === 'replaced' ? randomUUID() : profile.instance_id,
          status: 'ERROR', last_error: 'synthetic startup failure',
        });
        return { emitter: new EventEmitter(), kill: () => undefined };
      };
      let path = '/groups';
      let body: unknown = { group_name: 'owned', size: 2, kind: 'viewer' };
      if (action === 'resize') {
        const result = await harness.service.createGroup({ group_name: 'owned', size: 1, kind: 'viewer' });
        const member = inserted[0]!;
        harness.profiles.rows.set(member.name, { ...member, status: 'STOPPED' });
        inserted.splice(0);
        path = `/groups/${result.group.id}/members`;
        body = { count: 2 };
      }
      const app = await startRouterTestApp(createGroupsRouter(harness.service), '/groups');
      try {
        const response = await call(app, 'POST', path, body);
        assert.equal(response.status, 202);
        const returned = (response.body as { profiles: ProfileWithContainers[] }).profiles;
        assert.equal(returned.length, 2);
        assert.deepEqual(identities(returned), identities(inserted));
        assert.equal(returned.some(row => row.name === 'owned-profile-1'), false);
        if (change === 'same-instance-error') {
          assert.ok(returned.every(row => row.status === 'ERROR' && row.last_error === 'synthetic startup failure'));
        }
        if (change === 'replaced') {
          assert.ok(returned.every(row => harness.profiles.rows.get(row.name)!.instance_id !== row.instance_id));
        }
      } finally { await app.close(); }
    });
  }
}

it('single creation already preserves the inserted identity if startup is followed by replacement', async () => {
  const harness = profileServiceHarness();
  let inserted: Profile | undefined;
  harness.orchestrator.runReserved = async (_reservation, profile) => {
    inserted = structuredClone(profile);
    harness.profiles.rows.set(profile.name, { ...profile, instance_id: randomUUID() });
    return { emitter: new EventEmitter(), kill: () => undefined };
  };
  const app = await startRouterTestApp(createProfilesRouter(harness.service), '/profiles');
  try {
    const response = await call(app, 'POST', '/profiles', { name: 'owned', kind: 'viewer' });
    assert.equal(response.status, 202);
    assert.equal((response.body as Profile).instance_id, inserted!.instance_id);
    assert.notEqual((response.body as Profile).instance_id, harness.profiles.rows.get('owned')!.instance_id);
  } finally { await app.close(); }
});
