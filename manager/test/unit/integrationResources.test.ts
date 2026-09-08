import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { IntegrationResources } from '../integration/IntegrationResources.js';
import { IntegrationCleanupError } from '../integration/cleanupCreatedResources.js';
import type { CleanupRequest } from '../integration/cleanupHttpAdapter.js';

const profile = (name = 'itest-run-owned') => ({ name, instance_id: randomUUID() });
const options = { requestTimeoutMs: 20, removalTimeoutMs: 40, intervalMs: 1 };

function setup() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const request: CleanupRequest = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'DELETE' && path.startsWith('/profiles/')) return { status: 202, body: {
      name: decodeURIComponent(path.slice('/profiles/'.length)), instance_id: (body as { expectedInstanceId: string }).expectedInstanceId, status: 'REMOVING',
    } };
    if (method === 'GET' && path.startsWith('/profiles/')) return { status: 404, body: { error: 'profile_not_found', name: decodeURIComponent(path.slice('/profiles/'.length)) } };
    if (method === 'DELETE') return { status: 204 };
    return { status: 200, body: { groups: [] } };
  };
  return { calls, client: new IntegrationResources('run', request, options) };
}

for (const path of ['/profiles/', '/profiles?view=test', '/PROFILES', '/profiles/?view=test']) {
  it(`captures the creation route as Express resolves ${path}`, async () => {
    const { client, calls } = setup();
    const created = profile();
    await client.capture('POST', path, { name: created.name }, async () => ({ status: 202, body: created }));
    await client.cleanup();
    assert.deepEqual(calls.filter(call => call.method === 'DELETE').map(call => call.body), [{ expectedInstanceId: created.instance_id }]);
  });
}

it('records a successful creation before later assertions and cleans its confirmed instance', async () => {
  const { client, calls } = setup();
  const created = profile();
  const response = { status: 202, body: created };
  assert.equal(await client.capture('POST', '/profiles', { name: created.name }, async () => response), response);
  await client.cleanup();
  assert.deepEqual(calls[0], { method: 'DELETE', path: `/profiles/${created.name}`, body: { expectedInstanceId: created.instance_id } });
});

it('refuses explicit removal of a requested but unconfirmed name without a network call', async () => {
  const { client, calls } = setup();
  await client.capture('POST', '/profiles', { name: 'itest-run-guessed' }, async () => ({ status: 409, body: { error: 'profile_exists' } }));
  await assert.rejects(client.remove('itest-run-guessed'), /confirmed/i);
  await client.cleanup();
  assert.deepEqual(calls, []);
});

it('owns returned nonsequential group members and empty-group identity without discovering members', async () => {
  const { client, calls } = setup();
  const group = { id: 7, name: 'itest-run-owned' };
  const members = [profile('itest-run-owned-profile-2'), profile('itest-run-owned-profile-8')];
  await client.capture('POST', '/groups', { group_name: group.name, size: 2 }, async () => ({ status: 202, body: { group, profiles: members } }));
  await client.cleanup();
  assert.deepEqual(calls.filter(call => call.method === 'DELETE'), [
    ...members.map(member => ({ method: 'DELETE', path: `/profiles/${member.name}`, body: { expectedInstanceId: member.instance_id } })),
    { method: 'DELETE', path: '/groups/7', body: { expectedName: group.name } },
  ]);
  assert.equal(calls.some(call => call.path === '/profiles'), false);
});

it('captures raw-route member creation but never claims its preexisting group', async () => {
  const { client, calls } = setup();
  const member = profile();
  await client.capture('POST', '/groups/7/members', { count: 1 }, async () => ({ status: 202, body: { group: { id: 7, name: 'itest-run-existing' }, profiles: [member] } }));
  await client.remove(member.name);
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 1);
  assert.ok(calls.every(call => call.path.startsWith('/profiles/')));
});

it('keeps unresolved creation visible while cleaning confirmed resources independently', async () => {
  const { client, calls } = setup();
  const created = profile();
  await client.capture('POST', '/profiles', {}, async () => ({ status: 202, body: created }));
  await assert.rejects(client.capture('POST', '/profiles', { name: 'itest-run-maybe' }, async () => { throw new Error('connection closed'); }));
  await assert.rejects(client.cleanup(), error => error instanceof IntegrationCleanupError && error.failures.some(item => item.kind === 'creation'));
  assert.deepEqual(calls.filter(call => call.method === 'DELETE').map(call => call.path), [`/profiles/${created.name}`]);
});

it('treats an ABR node pool as four confirmed members regardless of its size input', async () => {
  const { client, calls } = setup();
  await client.capture('POST', '/groups', { abr_ladder: true, size: 1 }, async () => ({ status: 202, body: {
    group: { id: 7, name: 'itest-run-pool' }, profiles: ['360p', '480p', '720p', '1080p'].map(rung => profile(`itest-run-pool-${rung}`)),
  } }));
  await client.cleanup();
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 5);
});

for (const [path, body] of [['/groups', { size: '2' }], ['/groups/7/members', { count: '2' }]] as const) {
  for (const count of [1, 2]) {
    it(`uses coerced count for ${path}, with ${count} returned members`, async () => {
      const { client } = setup();
      await client.capture('POST', path, body, async () => ({ status: 202, body: {
        group: { id: 7, name: 'itest-run-owned' }, profiles: Array.from({ length: count }, (_, index) => profile(`itest-run-owned-profile-${index + 1}`)),
      } }));
      if (count === 2) await client.cleanup();
      else await assert.rejects(client.cleanup(), error => error instanceof IntegrationCleanupError && error.failures.some(item => item.reason === 'member-count-mismatch'));
    });
  }
}

it('recognizes the API boolean coercion for an ABR pool', async () => {
  const { client, calls } = setup();
  await client.capture('POST', '/groups', { abr_ladder: 'true', size: '1' }, async () => ({ status: 202, body: {
    group: { id: 7, name: 'itest-run-pool' }, profiles: ['360p', '480p', '720p', '1080p'].map(rung => profile(`itest-run-pool-${rung}`)),
  } }));
  await client.cleanup();
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 5);
});

it('does not turn ordinary GET or config responses into cleanup authority', async () => {
  const { client, calls } = setup();
  for (const method of ['GET', 'PUT']) await client.capture(method, '/profiles/itest-run-owned', {}, async () => ({ status: 200, body: profile() }));
  await assert.rejects(client.remove('itest-run-owned'), /confirmed/i);
  await client.cleanup();
  assert.deepEqual(calls, []);
});
