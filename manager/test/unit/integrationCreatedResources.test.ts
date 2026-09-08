import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CreatedResourceInventory } from '../integration/createdResources.js';

const FIRST = '10000000-0000-4000-8000-000000000001';
const SECOND = '10000000-0000-4000-8000-000000000002';
const THIRD = '10000000-0000-4000-8000-000000000003';
const profile = (instance_id = FIRST, name = 'itest-run-viewer-a') => ({ name, instance_id });
const group = { id: 17, name: 'itest-run-pool-a' };
const accepted = (body: unknown) => async () => ({ status: 202, body });

describe('confirmed integration resource inventory', () => {
  it('records the successful response before a later assertion fails', async () => {
    const inventory = new CreatedResourceInventory('run');
    const response = { status: 202, body: profile() };
    await assert.rejects(async () => {
      const returned = await inventory.capture({ kind: 'profile' }, async () => response);
      assert.equal(returned, response);
      assert.equal(returned.status, 400, 'a negative test unexpectedly created a profile');
    });
    assert.deepEqual(inventory.snapshot(), {
      profiles: [{ name: profile().name, instanceId: FIRST }], groups: [], unresolved: [],
    });
  });

  it('never treats a refused create response or a matching prefix as ownership', async () => {
    const inventory = new CreatedResourceInventory('run');
    await inventory.capture({ kind: 'profile' }, async () => ({ status: 409, body: profile() }));
    assert.deepEqual(inventory.snapshot(), { profiles: [], groups: [], unresolved: [] });
  });

  it('reports lost and server-error outcomes without adopting their body or exposing error content', async () => {
    const inventory = new CreatedResourceInventory('run');
    await assert.rejects(inventory.capture({ kind: 'profile' }, async () => {
      throw new Error('synthetic-private-payload');
    }), error => error instanceof Error && !error.message.includes('synthetic-private-payload'));
    await inventory.capture({ kind: 'profile' }, async () => ({ status: 500, body: profile() }));
    const snapshot = inventory.snapshot();
    assert.deepEqual(snapshot.profiles, []);
    assert.equal(snapshot.unresolved.length, 2);
    assert.ok(snapshot.unresolved.every(issue => issue.reason === 'response-unavailable'));
    assert.ok(!JSON.stringify(snapshot).includes('synthetic-private-payload'));
  });

  it('retains a confirmed group and each valid member of an incomplete response', async () => {
    const inventory = new CreatedResourceInventory('run');
    await inventory.capture({ kind: 'group', expectedMembers: 3 }, accepted({
      group, profiles: [profile(FIRST, 'itest-run-pool-a-profile-7'), null, profile(SECOND, 'itest-run-pool-a-profile-12')],
    }));
    assert.deepEqual(inventory.snapshot().groups, [group]);
    assert.deepEqual(inventory.snapshot().profiles.map(item => item.instanceId), [FIRST, SECOND]);
    assert.deepEqual(inventory.snapshot().unresolved.map(issue => issue.reason), ['invalid-member']);
  });

  it('retains a valid group with a missing member list and valid members with an invalid group', async () => {
    const inventory = new CreatedResourceInventory('run');
    await inventory.capture({ kind: 'group', expectedMembers: 1 }, accepted({ group, profiles: null }));
    await inventory.capture({ kind: 'group', expectedMembers: 1 }, accepted({ group: null, profiles: [profile()] }));
    assert.deepEqual(inventory.snapshot().groups, [group]);
    assert.equal(inventory.snapshot().profiles.length, 1);
    assert.deepEqual(inventory.snapshot().unresolved.map(issue => issue.reason), ['missing-members', 'invalid-group']);
  });

  it('captures only returned added members and never adopts an existing group', async () => {
    const inventory = new CreatedResourceInventory('run');
    await inventory.capture({ kind: 'members', groupId: 17, expectedMembers: 2 }, accepted({
      group, profiles: [profile(THIRD, 'itest-run-pool-a-profile-42')],
    }));
    assert.deepEqual(inventory.snapshot().groups, []);
    assert.deepEqual(inventory.snapshot().profiles, [{ name: 'itest-run-pool-a-profile-42', instanceId: THIRD }]);
    assert.deepEqual(inventory.snapshot().unresolved.map(issue => issue.reason), ['member-count-mismatch']);
  });

  it('does not grant authority from malformed or foreign successful identities', async () => {
    const inventory = new CreatedResourceInventory('run');
    for (const body of [null, {}, profile('not-a-uuid'), profile(FIRST, 'review-20260907')]) {
      await inventory.capture({ kind: 'profile' }, accepted(body));
    }
    assert.deepEqual(inventory.snapshot().profiles, []);
    assert.equal(inventory.snapshot().unresolved.length, 4);
  });

  it('deduplicates an identity while retaining separately created instances with the same name', async () => {
    const inventory = new CreatedResourceInventory('run');
    await inventory.capture({ kind: 'profile' }, accepted(profile()));
    await inventory.capture({ kind: 'profile' }, accepted(profile()));
    await inventory.capture({ kind: 'profile' }, accepted(profile(SECOND)));
    assert.deepEqual(inventory.snapshot().profiles.map(item => item.instanceId), [FIRST, SECOND]);
    assert.equal(inventory.snapshot().unresolved.length, 0);
  });

  it('does not allow a later response or mutable snapshot to change confirmed ownership', async () => {
    const inventory = new CreatedResourceInventory('run');
    const body = profile();
    await inventory.capture({ kind: 'profile' }, accepted(body));
    body.name = 'review-20260907';
    await inventory.capture({ kind: 'profile' }, accepted(profile(FIRST, 'itest-run-other-name')));
    const snapshot = inventory.snapshot();
    assert.throws(() => { (snapshot.profiles[0] as { name: string }).name = 'changed'; });
    assert.equal(inventory.snapshot().profiles[0]?.name, 'itest-run-viewer-a');
    assert.deepEqual(inventory.snapshot().unresolved.map(issue => issue.reason), ['identity-conflict']);
  });
});
