import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ManagerEvent } from '../../src/domain/EventBus.js';
import { untilRunning } from '../support/orchestratorHarness.js';
import { makeProfile } from '../support/profileFixtures.js';
import { profileServiceHarness } from '../support/profileServiceHarness.js';

const SECRET_ENDPOINT = 'https://rpc.example.invalid/v3/synthetic-key';
const REPLACEMENT_ENDPOINT = 'https://rpc.example.invalid/v3/replacement-key';

function assertEndpointIsPrivate(value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /synthetic-key|replacement-key/);
  assert.doesNotMatch(serialized, /"rpc_endpoint":/);
  assert.match(serialized, /"has_rpc_endpoint":true/);
  assert.match(serialized, /"rpc_endpoint_host":"rpc\.example\.invalid"/);
}

describe('custom RPC endpoint privacy', () => {
  it('keeps a keyed URL out of create, read, list and event projections', async () => {
    const harness = profileServiceHarness();
    const events: ManagerEvent[] = [];
    harness.events.subscribe((event) => events.push(event));

    const created = await harness.service.create({
      name: 'stage',
      kind: 'streamer',
      rpc_endpoint_source: 'custom',
      rpc_endpoint: SECRET_ENDPOINT,
    });

    assertEndpointIsPrivate(created);
    assertEndpointIsPrivate(await harness.service.getByName('stage'));
    assertEndpointIsPrivate(await harness.service.list());
    assertEndpointIsPrivate(events.filter((event) => event.type === 'profile.changed'));
  });

  it('keeps the URL out of group results and each member event', async () => {
    const harness = profileServiceHarness();
    const events: ManagerEvent[] = [];
    harness.events.subscribe((event) => events.push(event));

    const created = await harness.service.createGroup({
      group_name: 'gateways',
      size: 2,
      kind: 'viewer',
      node_mode: 'light',
      rpc_endpoint_source: 'custom',
      rpc_endpoint: SECRET_ENDPOINT,
    });

    assertEndpointIsPrivate(created.profiles);
    assertEndpointIsPrivate(await harness.groups.listMembers(created.group.id));
    assertEndpointIsPrivate(events.filter((event) => event.type === 'profile.changed'));

    for (const profile of created.profiles) {
      await untilRunning(harness.profiles, profile.name);
    }
    const appended = await harness.service.addGroupMembers(created.group.id, 1);
    assertEndpointIsPrivate(appended.profiles);
    assert.equal(
      (await harness.profiles.rpcEndpointOf(appended.profiles[0]!.name))?.rpcEndpoint,
      SECRET_ENDPOINT,
    );
  });

  it('preserves an omitted custom URL and deploys with the stored value', async () => {
    const harness = profileServiceHarness([makeProfile({
      name: 'stage',
      kind: 'streamer',
      rpc_endpoint_source: 'custom',
      rpc_endpoint: SECRET_ENDPOINT,
    })]);

    await harness.service.update('stage', { notes: 'kept' });

    assert.equal(harness.profiles.rpcEndpoints.get('stage'), SECRET_ENDPOINT);
  });

  it('replaces the URL only when a new one is sent and clears it on a source switch', async () => {
    const harness = profileServiceHarness([makeProfile({
      name: 'stage',
      kind: 'streamer',
      rpc_endpoint_source: 'custom',
      rpc_endpoint: SECRET_ENDPOINT,
    })]);

    await harness.service.update('stage', {
      rpc_endpoint_source: 'custom',
      rpc_endpoint: REPLACEMENT_ENDPOINT,
    });
    assert.equal(harness.profiles.rpcEndpoints.get('stage'), REPLACEMENT_ENDPOINT);
    await untilRunning(harness.profiles, 'stage');

    await harness.service.update('stage', {
      rpc_endpoint_source: 'stack',
      rpc_endpoint: null,
    });
    assert.equal(harness.profiles.rpcEndpoints.has('stage'), false);
    assert.equal(harness.profiles.rows.get('stage')?.rpc_endpoint_source, 'stack');
  });

  it('clears the URL when the API switches source without repeating it', async () => {
    const harness = profileServiceHarness([makeProfile({
      name: 'stage',
      kind: 'streamer',
      rpc_endpoint_source: 'custom',
      rpc_endpoint: SECRET_ENDPOINT,
    })]);

    await harness.service.update('stage', {
      rpc_endpoint_source: 'stack',
    });

    assert.equal(harness.profiles.rpcEndpoints.has('stage'), false);
    assert.equal(harness.profiles.rows.get('stage')?.rpc_endpoint_source, 'stack');
  });
});
