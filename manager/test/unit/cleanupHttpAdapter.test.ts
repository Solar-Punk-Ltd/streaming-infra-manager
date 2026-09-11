import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeEach, it } from 'node:test';

import { cleanupHttpAdapter, type CleanupRequest } from '../integration/cleanupHttpAdapter.js';

const profile = { name: 'itest-run-owned', instanceId: randomUUID() };
const group = { id: 42, name: 'itest-run-owned' };
const controller = new AbortController();
let calls: unknown[][];
let response: { status: number; body?: unknown };
const request: CleanupRequest = async (...args) => { calls.push(args); return response; };
const adapter = cleanupHttpAdapter(request);
beforeEach(() => { calls = []; response = { status: 500 }; });

it('sends the confirmed instance in the one DELETE with the cleanup deadline signal', async () => {
  response = { status: 202, body: { name: profile.name, instance_id: profile.instanceId, status: 'REMOVING' } };
  assert.equal(await adapter.remove(profile, controller.signal), 'accepted');
  assert.deepEqual(calls, [['DELETE', `/profiles/${profile.name}`, { expectedInstanceId: profile.instanceId }, controller.signal]]);
});

for (const [status, error, expected] of [[404, 'profile_not_found', 'absent'], [409, 'profile_instance_changed', 'replaced']] as const) {
  it(`recognizes only the named ${error} refusal`, async () => {
    response = { status, body: { error, name: profile.name } };
    assert.equal(await adapter.remove(profile, controller.signal), expected);
    response = { status, body: { error: 'different-error' } };
    await assert.rejects(adapter.remove(profile, controller.signal));
  });
}

for (const body of [undefined, {}, { name: profile.name, instance_id: randomUUID(), status: 'REMOVING' }, { name: 'other', instance_id: profile.instanceId, status: 'REMOVING' }]) {
  it(`refuses malformed or mismatched accepted removal ${JSON.stringify(body)}`, async () => {
    response = { status: 202, body };
    await assert.rejects(adapter.remove(profile, controller.signal));
    assert.equal(calls.length, 1);
  });
}

it('polls exact identity and treats a replacement as the original being gone', async () => {
  response = { status: 200, body: { name: profile.name, instance_id: profile.instanceId } };
  assert.equal(await adapter.read(profile, controller.signal), 'present');
  response = { status: 200, body: { name: profile.name, instance_id: randomUUID() } };
  assert.equal(await adapter.read(profile, controller.signal), 'replaced');
  response = { status: 404, body: { error: 'profile_not_found', name: profile.name } };
  assert.equal(await adapter.read(profile, controller.signal), 'absent');
  assert.ok(calls.every(call => call[0] === 'GET' && call[3] === controller.signal));
});

for (const result of [{ status: 404 }, { status: 200, body: {} }, { status: 200, body: { name: profile.name, instance_id: 'invalid' } }, { status: 200, body: { name: 'other', instance_id: profile.instanceId } }]) {
  it(`does not convert an invalid profile read into absence ${JSON.stringify(result)}`, async () => {
    response = result;
    await assert.rejects(adapter.read(profile, controller.signal));
  });
}

it('uses atomic group DELETE with expected name and never reads members first', async () => {
  response = { status: 204 };
  assert.equal(await adapter.removeEmptyGroup(group, controller.signal), 'accepted');
  assert.deepEqual(calls, [['DELETE', '/groups/42', { expectedName: group.name }, controller.signal]]);
});

for (const [error, expected] of [['group_changed', 'changed'], ['group_not_empty', 'not-empty']] as const) {
  it(`reports ${error} without another request`, async () => {
    response = { status: 409, body: { error, id: group.id } };
    assert.equal(await adapter.removeEmptyGroup(group, controller.signal), expected);
    assert.equal(calls.length, 1);
  });
}

it('does not count a generic group404 or unrelated refusal as successful cleanup', async () => {
  for (const result of [{ status: 404 }, { status: 409, body: { error: 'group_changed', id: 8 } }, { status: 409, body: { error: 'group_busy', id: 42 } }]) {
    response = result;
    await assert.rejects(adapter.removeEmptyGroup(group, controller.signal));
  }
});

it('confirms group absence only from a valid list and cannot adopt a changed same-ID group', async () => {
  response = { status: 200, body: { groups: [group] } };
  assert.equal(await adapter.groupExists(group, controller.signal), true);
  response = { status: 200, body: { groups: [{ ...group, id: 43 }] } };
  assert.equal(await adapter.groupExists(group, controller.signal), false);
  for (const body of [{}, { groups: [{}] }, { groups: [group, group] }, { groups: [{ ...group, name: 'other' }] }]) {
    response = { status: 200, body };
    await assert.rejects(adapter.groupExists(group, controller.signal));
  }
});

it('propagates a lost DELETE response without a retry or a name-only fallback', async () => {
  let count = 0;
  const failing = cleanupHttpAdapter(async () => { count += 1; throw new Error('synthetic connection closed'); });
  await assert.rejects(failing.remove(profile, controller.signal), /connection closed/);
  assert.equal(count, 1);
});
