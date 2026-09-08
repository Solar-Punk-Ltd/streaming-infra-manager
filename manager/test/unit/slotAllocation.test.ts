/**
 * Which slot a new deployment gets, and what that reserves.
 *
 * Unit test over the in-memory tables, no database and no Docker. `pnpm test`
 * in manager/. The rules the Postgres allocator applies under its advisory
 * lock, mirrored here: the lowest slot number no record holds and no port of
 * which another deployment holds on the daemon, every port of it reserved
 * planned in the same step, a whole group or none of it, and a cap that
 * counts every stored record, stopped ones included.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STANDARD_GROUP_KIND, type StackPortVar } from '@streaming-infra-manager/common';

import type { NewProfilePlacement } from '../../src/domain/ProfileRepository.js';
import type { SharedProfileParams } from '../../src/domain/DeploymentGroupRepository.js';
import { AllSlotsUsedError } from '../../src/domain/errors/index.js';
import { InMemoryPortReservations } from '../support/InMemoryPortReservations.js';
import { InMemoryProfiles, makeProfile } from '../support/profileFixtures.js';
import { InMemoryGroups } from '../support/profileServiceHarness.js';

const TABLE_X: StackPortVar[] = [
  { name: 'API_PORT', defaultPort: 10000, slotBase: 10000, protocol: 'tcp', service: 'stream-uploader' },
  { name: 'SRS_SRT_PORT', defaultPort: 10001, slotBase: 10001, protocol: 'udp', service: 'srs' },
];

/** A table whose slot 1 API port is table X's slot 2 API port: 10010 + 10 = 10000 + 20. */
const TABLE_Y: StackPortVar[] = [
  { name: 'API_PORT', defaultPort: 3000, slotBase: 10010, protocol: 'tcp', service: 'stream-uploader' },
];

const placement = (table: StackPortVar[], slotCap: number, daemonId = 'daemon-1'): NewProfilePlacement => ({
  stackVersionId: 1,
  slotCap,
  daemonId,
  table,
});

const shared = (table: StackPortVar[], slotCap: number): SharedProfileParams => ({
  kind: 'custom',
  notes: null,
  components: null,
  host: 'localhost',
  feed_owner: null,
  feed_topic: null,
  private_key: null,
  public_key: null,
  stamp_id: null,
  srt_passphrase: null,
  stack_version_id: 1,
  slot_cap: slotCap,
  daemon_id: 'daemon-1',
  table,
});

function tables(stored: readonly ReturnType<typeof makeProfile>[] = []) {
  const reservations = new InMemoryPortReservations();
  const profiles = new InMemoryProfiles(stored, reservations);
  return { reservations, profiles };
}

describe('allocating a port slot', () => {
  it('does not allocate a private service onto publicly allowed peer ports', async () => {
    const { reservations, profiles } = tables();
    const unsafe = [{ ...TABLE_X[0]!, slotBase: 11002 }];
    assert.equal(await profiles.insertWithFreeSlot('a', 'custom', 'DEPLOYING', {}, placement(unsafe, 2)), null);
    assert.equal(reservations.rows.length, 0);
  });

  it('takes the lowest slot whose every port is free, and reserves each port of it planned in the deployment\'s name', async () => {
    const { reservations, profiles } = tables();

    const row = await profiles.insertWithFreeSlot('a', 'custom', 'DEPLOYING', { host: 'localhost' }, placement(TABLE_X, 100));

    assert.equal(row?.port_slot, 1);
    const held = await reservations.listByProfile('a');
    assert.deepEqual(
      held.map((entry) => [entry.daemonId, entry.protocol, entry.port, entry.portVar, entry.service, entry.state]).sort(),
      [
        ['daemon-1', 'tcp', 10010, 'API_PORT', 'stream-uploader', 'planned'],
        ['daemon-1', 'udp', 10011, 'SRS_SRT_PORT', 'srs', 'planned'],
      ],
    );
  });

  it('skips a slot number whose ports another deployment\'s version already holds', async () => {
    const { profiles } = tables();
    await profiles.insertWithFreeSlot('y1', 'custom', 'DEPLOYING', { host: 'localhost' }, placement(TABLE_Y, 100));

    const row = await profiles.insertWithFreeSlot('x1', 'custom', 'DEPLOYING', { host: 'localhost' }, placement(TABLE_X, 100));

    assert.equal(row?.port_slot, 3, 'slot 2 would bind 10020, which y1 holds from slot 1 of its own table');
  });

  it('keeps daemons apart: the same port on another daemon is free', async () => {
    const { profiles } = tables();
    await profiles.insertWithFreeSlot('y1', 'custom', 'DEPLOYING', { host: 'localhost' }, placement(TABLE_Y, 100));

    const row = await profiles.insertWithFreeSlot('x1', 'custom', 'DEPLOYING', { host: 'remote' }, placement(TABLE_X, 100, 'daemon-2'));

    assert.equal(row?.port_slot, 2);
  });

  it('counts every stored record toward the cap, stopped ones included, and answers null past it', async () => {
    const stored = Array.from({ length: 99 }, (_value, index) =>
      makeProfile({ name: `p${index}`, port_slot: index + 1, status: index % 2 === 0 ? 'RUNNING' : 'STOPPED' }),
    );
    const { profiles } = tables(stored);

    const hundredth = await profiles.insertWithFreeSlot('h', 'custom', 'DEPLOYING', { host: 'localhost' }, placement(TABLE_X, 100));
    const past = await profiles.insertWithFreeSlot('more', 'custom', 'DEPLOYING', { host: 'localhost' }, placement(TABLE_X, 100));

    assert.equal(hundredth?.port_slot, 100);
    assert.equal(past, null);
  });

  it('never hands out a slot above a version\'s own maximum', async () => {
    const stored = Array.from({ length: 99 }, (_value, index) => makeProfile({ name: `p${index}`, port_slot: index + 1 }));
    const { profiles } = tables(stored);

    assert.equal(await profiles.insertWithFreeSlot('h', 'custom', 'DEPLOYING', { host: 'localhost' }, placement(TABLE_X, 99)), null);
  });

  it('reserves a whole group or none of it', async () => {
    const { reservations, profiles } = tables([makeProfile({ name: 'one', port_slot: 1 })]);
    const groups = new InMemoryGroups(profiles);

    await assert.rejects(
      groups.createGroupWithMembers('g', STANDARD_GROUP_KIND, [{ name: 'g-1' }, { name: 'g-2' }], shared(TABLE_X, 2)),
      AllSlotsUsedError,
    );

    assert.deepEqual([...profiles.rows.keys()], ['one']);
    assert.deepEqual(await reservations.listByDaemon('daemon-1'), []);
  });

  it('reserves every member of a group that fits', async () => {
    const { reservations, profiles } = tables();
    const groups = new InMemoryGroups(profiles);

    const { profiles: members } = await groups.createGroupWithMembers('g', STANDARD_GROUP_KIND, [{ name: 'g-1' }, { name: 'g-2' }], shared(TABLE_X, 100));

    assert.deepEqual(members.map((member) => member.port_slot), [1, 2]);
    assert.equal((await reservations.listByDaemon('daemon-1')).length, 4);
  });
});
