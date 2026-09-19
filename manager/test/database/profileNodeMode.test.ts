/**
 * The two columns T27 adds, against a real PostgreSQL.
 *
 * `pnpm test:database` in manager/, or on its own with T04B_TEST_PG_PORT set.
 *
 * A CHECK constraint and a backfill are the two things a unit test cannot
 * judge: the first only refuses inside the database, and the second only
 * happens to rows that were written before the migration ran. This file runs
 * the migrations into a schema of its own, once whole and once stopping before
 * 035, so both are exercised the way an upgrade of the live manager would
 * exercise them.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import pg, { type Pool } from 'pg';

import { STANDARD_GROUP_KIND } from '@streaming-infra-manager/common';

import {
  DeploymentGroupRepository,
  type SharedProfileParams,
} from '../../src/domain/DeploymentGroupRepository.js';
import { ProfileRepository } from '../../src/domain/ProfileRepository.js';

const port = Number(process.env.T04B_TEST_PG_PORT);
const connection = {
  host: '127.0.0.1',
  port,
  user: 'postgres',
  database: 't04b_test',
  connectionTimeoutMillis: 10000,
};

const PLACEMENT = {
  stackVersionId: 1,
  slotCap: 99,
  daemonId: 'synthetic-daemon',
  table: [],
};

const ENDPOINT = 'https://rpc.example.org';

/**
 * What every member of a group is created with, as ProfileService builds it.
 * Only the three fields this file is about are worth varying.
 */
const sharedParams = (
  over: Pick<
    Partial<SharedProfileParams>,
    'node_mode' | 'rpc_endpoint_source' | 'rpc_endpoint'
  > = {},
): SharedProfileParams => ({
  kind: 'custom',
  notes: null,
  components: ['bee-uploader'],
  host: null,
  feed_owner: null,
  feed_topic: null,
  private_key: null,
  public_key: null,
  stamp_id: null,
  srt_passphrase: null,
  node_mode: over.node_mode ?? null,
  rpc_endpoint_source: over.rpc_endpoint_source ?? 'stack',
  rpc_endpoint: over.rpc_endpoint ?? null,
  stack_version_id: 1,
  engine_settings: {},
  slot_cap: 99,
  daemon_id: 'synthetic-daemon',
  table: [],
});

describe('the node mode and endpoint source columns in isolated PostgreSQL', {
  skip: !Number.isInteger(port) || port < 1 || port > 65535,
}, () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;
  let profiles: ProfileRepository;

  /** The migrations in order, all of them or the slice a test asks for. */
  async function migrate(
    target: Pool,
    range: { from?: string; until?: string } = {},
  ): Promise<void> {
    const directory = new URL('../../src/migrations/', import.meta.url);
    const names = (await readdir(directory))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    for (const name of names) {
      if (range.from && name < range.from) continue;
      if (range.until && name >= range.until) break;
      await target.query(await readFile(new URL(name, directory), 'utf8'));
    }
  }

  beforeEach(async () => {
    schema = `t04b_node_mode_${randomBytes(8).toString('hex')}`;
    admin = new pg.Pool(connection);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, max: 4, options: `-c search_path=${schema}` });
    profiles = new ProfileRepository(pool);
  });

  afterEach(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('stores the stack and no mode for a deployment that names neither', async () => {
    await migrate(pool);

    const row = await profiles.insertWithFreeSlot('plain', 'custom', 'RUNNING', {}, PLACEMENT);

    assert.equal(row?.rpc_endpoint_source, 'stack');
    assert.equal(row?.node_mode, null);
  });

  it('stores a mode and a custom address, and reads both back', async () => {
    await migrate(pool);

    await profiles.insertWithFreeSlot('chosen', 'viewer', 'RUNNING', {
      node_mode: 'light',
      rpc_endpoint_source: 'custom',
      rpc_endpoint: ENDPOINT,
    }, PLACEMENT);
    const read = await profiles.findByName('chosen');

    assert.equal(read?.node_mode, 'light');
    assert.equal(read?.rpc_endpoint_source, 'custom');
    assert.equal(read?.has_rpc_endpoint, true);
    assert.equal(read?.rpc_endpoint_host, 'rpc.example.org');
    assert.equal((await profiles.rpcEndpointOf('chosen'))?.rpcEndpoint, ENDPOINT);
  });

  it('refuses a custom source with no address', async () => {
    await migrate(pool);

    await assert.rejects(
      () => profiles.insertWithFreeSlot('half', 'custom', 'RUNNING', {
        rpc_endpoint_source: 'custom',
      }, PLACEMENT),
      /profiles_rpc_endpoint_source_pairing/,
    );
  });

  it('refuses an address beside a source that does not carry one', async () => {
    await migrate(pool);

    await assert.rejects(
      () => profiles.insertWithFreeSlot('both', 'custom', 'RUNNING', {
        rpc_endpoint_source: 'manager',
        rpc_endpoint: ENDPOINT,
      }, PLACEMENT),
      /profiles_rpc_endpoint_source_pairing/,
    );
  });

  it('refuses a mode the shared rule does not know', async () => {
    await migrate(pool);

    await assert.rejects(
      () => profiles.insertWithFreeSlot('odd', 'custom', 'RUNNING', {
        node_mode: 'full' as 'light',
      }, PLACEMENT),
      /node_mode/,
    );
  });

  it('keeps the stored mode and source through an update that says nothing', async () => {
    await migrate(pool);
    await profiles.insertWithFreeSlot('kept', 'custom', 'RUNNING', {
      node_mode: 'ultra-light',
      rpc_endpoint_source: 'manager',
    }, PLACEMENT);

    const written = await profiles.updateEditable('kept', 'custom', { notes: 'edited' });

    // A node's mode is chosen when it is created, and where an endpoint goes
    // when its address is emptied is the service's to work out, because it
    // depends on whether this manager has an endpoint at all. The statement
    // keeps both rather than holding a second opinion.
    assert.equal(written?.node_mode, 'ultra-light');
    assert.equal(written?.rpc_endpoint_source, 'manager');
  });

  it('refuses an explicit clear that leaves the source custom', async () => {
    await migrate(pool);
    await profiles.insertWithFreeSlot('stranded', 'custom', 'RUNNING', {
      rpc_endpoint_source: 'custom',
      rpc_endpoint: ENDPOINT,
    }, PLACEMENT);

    // What a caller that resolved neither would leave behind. ProfileService
    // never sends this, and the column's CHECK is what says so for anything
    // that would.
    await assert.rejects(
      () => profiles.updateEditable('stranded', 'custom', {
        notes: 'edited',
        rpc_endpoint: null,
      }),
      /profiles_rpc_endpoint_source_pairing/,
    );
  });

  it('keeps a stored endpoint choice through an update that says nothing', async () => {
    await migrate(pool);
    await profiles.insertWithFreeSlot('held', 'viewer', 'RUNNING', {
      node_mode: 'light',
      rpc_endpoint_source: 'manager',
    }, PLACEMENT);

    const written = await profiles.updateEditable('held', 'viewer', { notes: 'edited' });

    // The edit drawer shows no endpoint field for a deployment that owns no
    // bee-uploader, so a saved note must not move this one onto the stack's
    // public RPC.
    assert.equal(written?.rpc_endpoint_source, 'manager');
  });

  it('keeps a stored custom address through an update that says nothing', async () => {
    await migrate(pool);
    await profiles.insertWithFreeSlot('held-custom', 'viewer', 'RUNNING', {
      node_mode: 'light',
      rpc_endpoint_source: 'custom',
      rpc_endpoint: ENDPOINT,
    }, PLACEMENT);

    const written = await profiles.updateEditable('held-custom', 'viewer', {
      notes: 'edited',
    });

    assert.equal(written?.rpc_endpoint_source, 'custom');
    assert.equal(written?.has_rpc_endpoint, true);
    assert.equal(written?.rpc_endpoint_host, 'rpc.example.org');
    assert.equal((await profiles.rpcEndpointOf('held-custom'))?.rpcEndpoint, ENDPOINT);
  });

  it('stores the address and the source the caller resolved together', async () => {
    await migrate(pool);
    await profiles.insertWithFreeSlot('adopting', 'custom', 'RUNNING', {}, PLACEMENT);

    const written = await profiles.updateEditable('adopting', 'custom', {
      rpc_endpoint: ENDPOINT,
      rpc_endpoint_source: 'custom',
    });

    assert.equal(written?.rpc_endpoint_source, 'custom');
    assert.equal(written?.has_rpc_endpoint, true);
    assert.equal(written?.rpc_endpoint_host, 'rpc.example.org');
    assert.equal((await profiles.rpcEndpointOf('adopting'))?.rpcEndpoint, ENDPOINT);
  });

  it('gives every member of a group the mode and the endpoint it was created with', async () => {
    await migrate(pool);
    const groups = new DeploymentGroupRepository(pool);

    const { profiles: members } = await groups.createGroupWithMembers(
      'pool',
      STANDARD_GROUP_KIND,
      [{ name: 'pool-one' }, { name: 'pool-two' }],
      sharedParams({
        node_mode: 'light',
        rpc_endpoint_source: 'custom',
        rpc_endpoint: ENDPOINT,
      }),
    );

    // Every rung of a pool is one node of one deployment's worth of chain, so a
    // member that reached the chain differently from its siblings would be a
    // pool nobody could reason about.
    assert.deepEqual(members.map((member) => member.node_mode), ['light', 'light']);
    assert.deepEqual(
      members.map((member) => member.rpc_endpoint_source),
      ['custom', 'custom'],
    );
    assert.deepEqual(members.map((member) => member.has_rpc_endpoint), [true, true]);
    assert.deepEqual(members.map((member) => member.rpc_endpoint_host), [
      'rpc.example.org',
      'rpc.example.org',
    ]);
    assert.deepEqual(
      await Promise.all(members.map((member) => profiles.rpcEndpointOf(member.name))),
      [{ rpcEndpoint: ENDPOINT }, { rpcEndpoint: ENDPOINT }],
    );
  });

  it('gives a group that names neither what the stack ships', async () => {
    await migrate(pool);
    const groups = new DeploymentGroupRepository(pool);

    const { profiles: members } = await groups.createGroupWithMembers(
      'plain-pool',
      STANDARD_GROUP_KIND,
      [{ name: 'plain-one' }],
      sharedParams(),
    );

    assert.equal(members[0]?.node_mode, null);
    assert.equal(members[0]?.rpc_endpoint_source, 'stack');
  });

  it('gives a member appended later what its siblings run', async () => {
    await migrate(pool);
    const groups = new DeploymentGroupRepository(pool);
    const { group } = await groups.createGroupWithMembers(
      'growing',
      STANDARD_GROUP_KIND,
      [{ name: 'growing-one' }],
      sharedParams({ node_mode: 'light', rpc_endpoint_source: 'manager' }),
    );

    const added = await groups.addMembers(
      group.id,
      [{ name: 'growing-two' }],
      sharedParams({ node_mode: 'light', rpc_endpoint_source: 'manager' }),
    );

    assert.equal(added[0]?.node_mode, 'light');
    assert.equal(added[0]?.rpc_endpoint_source, 'manager');
  });

  it('reads a deployment that already named an address as a custom one', async () => {
    await migrate(pool, { until: '035_' });
    await pool.query(
      `INSERT INTO profiles (name, port_slot, kind, rpc_endpoint, stack_version_id)
       VALUES ('legacy', 7, 'custom', $1, (SELECT id FROM stack_versions WHERE name = 'bundled'))`,
      [ENDPOINT],
    );

    await migrate(pool, { from: '035_' });
    const read = await profiles.findByName('legacy');

    // It has always reached the chain through that address, so anything but
    // custom would move it somewhere else on its next deploy.
    assert.equal(read?.rpc_endpoint_source, 'custom');
    assert.equal(read?.has_rpc_endpoint, true);
    assert.equal(read?.rpc_endpoint_host, 'rpc.example.org');
    assert.equal((await profiles.rpcEndpointOf('legacy'))?.rpcEndpoint, ENDPOINT);
    assert.equal(read?.node_mode, null);
  });
});
