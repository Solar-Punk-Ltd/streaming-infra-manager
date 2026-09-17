/**
 * What a create and an update may say about a node's mode and its endpoint.
 *
 * Unit test, no database and no deploy script. `pnpm test` in manager/.
 *
 * The rules themselves live in common, where the wizard reads them too. What
 * this file pins is that both request paths ask them, and that each path asks
 * with everything it knows: a create body carries the services, an update body
 * carries neither `kind` nor `components`, so the update's answer has to come
 * from the stored row rather than from the patch. That gap is the one
 * `beeTargetProblem` was written for, and it is the same gap here.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createGroupSchema,
  createProfileSchema,
  updateProfileSchema,
} from '../../src/schemas/profile.js';
import { makeProfile } from '../support/profileFixtures.js';
import { profileServiceHarness } from '../support/profileServiceHarness.js';

const ENDPOINT = 'https://rpc.example.org';
const MANAGER_ENDPOINT = 'https://rpc.manager.example.org/key';

const withManager = { context: { managerHasEndpoint: true } };
const withoutManager = { context: { managerHasEndpoint: false } };

const create = (body: Record<string, unknown>, options = withManager) =>
  createProfileSchema.validate({ name: 'stage', ...body }, { abortEarly: false, ...options });

const update = (body: Record<string, unknown>, options = withManager) =>
  updateProfileSchema.validate(body, { abortEarly: false, ...options });

const createGroup = (body: Record<string, unknown>, options = withManager) =>
  createGroupSchema.validate(
    { group_name: 'pool', size: 2, ...body },
    { abortEarly: false, ...options },
  );

describe('the node mode a body may carry', () => {
  it('takes either mode on a create', async () => {
    assert.equal((await create({ kind: 'viewer', node_mode: 'light' })).node_mode, 'light');
    assert.equal(
      (await create({ kind: 'custom', components: ['bee-gateway'], node_mode: 'ultra-light' })).node_mode,
      'ultra-light',
    );
  });

  it('refuses a mode that is neither', async () => {
    await assert.rejects(() => create({ node_mode: 'full' }), /node_mode/);
  });

  it('leaves the field out when the body says nothing, so the stack decides', async () => {
    assert.equal((await create({ kind: 'viewer' })).node_mode, undefined);
  });

  it('carries the field on an update, so the service can refuse a change', async () => {
    assert.equal((await update({ node_mode: 'light' })).node_mode, 'light');
  });
});

describe('the endpoint source a body may carry', () => {
  it('takes each source', async () => {
    assert.equal((await create({ rpc_endpoint_source: 'manager' })).rpc_endpoint_source, 'manager');
    assert.equal((await create({ rpc_endpoint_source: 'stack' })).rpc_endpoint_source, 'stack');
    assert.equal(
      (await create({ rpc_endpoint_source: 'custom', rpc_endpoint: ENDPOINT })).rpc_endpoint_source,
      'custom',
    );
  });

  it('refuses a source that is none of the three', async () => {
    await assert.rejects(
      () => create({ rpc_endpoint_source: 'whatever' }),
      /rpc_endpoint_source/,
    );
  });

  it('refuses a custom source with no address', async () => {
    await assert.rejects(
      () => create({ rpc_endpoint_source: 'custom' }),
      /a custom RPC endpoint needs an address/,
    );
    await assert.rejects(
      () => update({ rpc_endpoint_source: 'custom' }),
      /a custom RPC endpoint needs an address/,
    );
  });

  it('refuses an address beside a source that does not carry one', async () => {
    await assert.rejects(
      () => create({ rpc_endpoint_source: 'manager', rpc_endpoint: ENDPOINT }),
      /only a custom RPC endpoint carries an address/,
    );
  });

  it('refuses the manager’s endpoint when the manager has none', async () => {
    await assert.rejects(
      () => create({ rpc_endpoint_source: 'manager' }, withoutManager),
      /the manager has no RPC endpoint configured/,
    );
  });

  it('refuses the stack’s default for a gateway put on the chain', async () => {
    await assert.rejects(
      () => create({ kind: 'viewer', node_mode: 'light', rpc_endpoint_source: 'stack' }),
      /a light gateway needs an endpoint/,
    );
  });

  it('takes an address with no source, as the API always did', async () => {
    // Nothing broke the day a source existed: an address alone means a custom
    // one, which is what the migration reads such a stored row as.
    const body = await create({ rpc_endpoint: ENDPOINT });
    assert.equal(body.rpc_endpoint, ENDPOINT);
  });

  it('says nothing about an update that names no source', async () => {
    // The stored row decides it, and no update body carries kind or
    // components, so the schema cannot see whether this is a light gateway.
    assert.equal((await update({ notes: 'just a note' })).rpc_endpoint_source, undefined);
  });
});

describe('a new deployment’s mode and endpoint', () => {
  it('refuses a publisher asked to run with no chain, and stores nothing', async () => {
    const harness = profileServiceHarness();

    await assert.rejects(
      harness.service.create({ name: 'stage', kind: 'streamer', node_mode: 'ultra-light' }),
      /an ultra-light node cannot upload/,
    );
    assert.equal(harness.profiles.rows.has('stage'), false);
  });

  it('stores the mode and the source the body names', async () => {
    const harness = profileServiceHarness([], MANAGER_ENDPOINT);

    await harness.service.create({
      name: 'gateway',
      kind: 'viewer',
      node_mode: 'light',
      rpc_endpoint_source: 'manager',
    });

    const row = harness.profiles.rows.get('gateway');
    assert.equal(row?.node_mode, 'light');
    assert.equal(row?.rpc_endpoint_source, 'manager');
  });

  it('offers the manager’s endpoint to a body that names no source', async () => {
    const configured = profileServiceHarness([], MANAGER_ENDPOINT);
    const bare = profileServiceHarness();

    await configured.service.create({ name: 'one', kind: 'streamer' });
    await bare.service.create({ name: 'two', kind: 'streamer' });

    assert.equal(configured.profiles.rows.get('one')?.rpc_endpoint_source, 'manager');
    assert.equal(bare.profiles.rows.get('two')?.rpc_endpoint_source, 'stack');
  });

  it('refuses a light gateway that would take the stack’s default', async () => {
    const harness = profileServiceHarness();

    await assert.rejects(
      harness.service.create({ name: 'gateway', kind: 'viewer', node_mode: 'light' }),
      /a light gateway needs an endpoint/,
    );
    assert.equal(harness.profiles.rows.has('gateway'), false);
  });
});

describe('an edit of a deployment that already exists', () => {
  const stored = (over = {}) =>
    makeProfile({ name: 'stage', kind: 'streamer', status: 'RUNNING', ...over });

  it('refuses a mode that differs from the one the node was created with', async () => {
    const harness = profileServiceHarness([stored({ node_mode: 'light' })]);

    await assert.rejects(
      harness.service.update('stage', { node_mode: 'ultra-light' }),
      /chosen when it is created/,
    );
    assert.equal(harness.profiles.rows.get('stage')?.node_mode, 'light');
  });

  it('takes a body that repeats the mode the node already runs in', async () => {
    // A page that shows the mode sends it back with everything else it shows.
    const harness = profileServiceHarness([stored({ node_mode: 'light' })]);

    await harness.service.update('stage', { node_mode: 'light', notes: 'edited' });

    assert.equal(harness.profiles.rows.get('stage')?.node_mode, 'light');
  });

  it('reads a stored null as the mode the stack ships, not as a difference', async () => {
    const harness = profileServiceHarness([stored({ node_mode: null })]);

    await harness.service.update('stage', { node_mode: 'light' });

    assert.equal(harness.profiles.rows.get('stage')?.node_mode, 'light');
  });

  it('keeps a stored endpoint choice through an edit that never mentions it', async () => {
    // The drawer shows no endpoint field for a deployment that owns no
    // bee-uploader, so a saved note must not move it onto the stack's public
    // RPC.
    const harness = profileServiceHarness(
      [stored({ kind: 'viewer', node_mode: 'light', rpc_endpoint_source: 'manager' })],
      MANAGER_ENDPOINT,
    );

    await harness.service.update('stage', { notes: 'edited' });

    assert.equal(harness.profiles.rows.get('stage')?.rpc_endpoint_source, 'manager');
  });

  it('reads an address arriving with no source as the custom one', async () => {
    const harness = profileServiceHarness([stored({ rpc_endpoint_source: 'stack' })]);

    await harness.service.update('stage', { rpc_endpoint: ENDPOINT });

    assert.equal(harness.profiles.rows.get('stage')?.rpc_endpoint_source, 'custom');
  });

  it('takes the custom choice away with the address it belongs to', async () => {
    const harness = profileServiceHarness([
      stored({ rpc_endpoint_source: 'custom', rpc_endpoint: ENDPOINT }),
    ]);

    await harness.service.update('stage', { notes: 'cleared' });

    const row = harness.profiles.rows.get('stage');
    assert.equal(row?.rpc_endpoint, null);
    assert.equal(row?.rpc_endpoint_source, 'stack');
  });

  it('refuses an edit that puts a light gateway on the stack’s default', async () => {
    const harness = profileServiceHarness(
      [stored({ kind: 'viewer', node_mode: 'light', rpc_endpoint_source: 'manager' })],
      MANAGER_ENDPOINT,
    );

    await assert.rejects(
      harness.service.update('stage', { rpc_endpoint_source: 'stack' }),
      /a light gateway needs an endpoint/,
    );
  });
});

describe('the mode and endpoint a group’s create body may carry', () => {
  it('takes all three fields', async () => {
    const body = await createGroup({
      abr_ladder: true,
      node_mode: 'light',
      rpc_endpoint_source: 'custom',
      rpc_endpoint: ENDPOINT,
    });

    assert.equal(body.node_mode, 'light');
    assert.equal(body.rpc_endpoint_source, 'custom');
    assert.equal(body.rpc_endpoint, ENDPOINT);
  });

  it('holds a group to the refusals a single create answers to', async () => {
    await assert.rejects(
      () => createGroup({ rpc_endpoint_source: 'custom' }),
      /a custom RPC endpoint needs an address/,
    );
    await assert.rejects(
      () => createGroup({ rpc_endpoint_source: 'manager' }, withoutManager),
      /the manager has no RPC endpoint configured/,
    );
    await assert.rejects(
      () => createGroup({ kind: 'viewer', node_mode: 'light', rpc_endpoint_source: 'stack' }),
      /a light gateway needs an endpoint/,
    );
  });

  it('judges a pool by what its rungs are, not by what the body’s components say', async () => {
    // A ladder's members are one bee-uploader each whatever `components`
    // carries, so the gateway rule cannot apply to them.
    const body = await createGroup({
      abr_ladder: true,
      components: ['client', 'bee-gateway'],
      node_mode: 'light',
      rpc_endpoint_source: 'stack',
    });

    assert.equal(body.node_mode, 'light');
  });
});

describe('a new group’s mode and endpoint', () => {
  it('refuses a pool of publishers asked to run with no chain, and creates nothing', async () => {
    const harness = profileServiceHarness();

    await assert.rejects(
      harness.service.createGroup({
        group_name: 'pool',
        size: 4,
        kind: 'custom',
        abr_ladder: true,
        node_mode: 'ultra-light',
      }),
      /an ultra-light node cannot upload/,
    );
    assert.equal(harness.profiles.rows.size, 0);
    assert.equal(harness.groups.groups.length, 0);
  });

  it('gives every member the mode and the source the body names', async () => {
    const harness = profileServiceHarness([], MANAGER_ENDPOINT);

    await harness.service.createGroup({
      group_name: 'pool',
      size: 2,
      kind: 'custom',
      components: ['bee-uploader'],
      node_mode: 'light',
      rpc_endpoint_source: 'manager',
    });

    for (const name of ['pool-profile-1', 'pool-profile-2']) {
      const row = harness.profiles.rows.get(name);
      assert.equal(row?.node_mode, 'light', name);
      assert.equal(row?.rpc_endpoint_source, 'manager', name);
    }
  });

  it('offers the manager’s endpoint to a group body that names no source', async () => {
    const configured = profileServiceHarness([], MANAGER_ENDPOINT);
    const bare = profileServiceHarness();

    await configured.service.createGroup({ group_name: 'one', size: 1, kind: 'custom' });
    await bare.service.createGroup({ group_name: 'two', size: 1, kind: 'custom' });

    assert.equal(configured.profiles.rows.get('one-profile-1')?.rpc_endpoint_source, 'manager');
    assert.equal(bare.profiles.rows.get('two-profile-1')?.rpc_endpoint_source, 'stack');
  });
});
