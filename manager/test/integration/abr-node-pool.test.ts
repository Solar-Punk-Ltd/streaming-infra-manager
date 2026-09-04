/**
 * ABR node pool integration tests.
 *
 * A pool is four `bee-uploader` profiles named `<pool>-<rung>`, created STOPPED
 * — `createGroup` never calls the orchestrator — so unlike the other suites
 * these start no containers and run in seconds. What they exercise is the part
 * that is easy to get wrong and invisible to unit tests: the group row's kind
 * surviving a round trip, the member names the rungs are derived from, and the
 * three refusals that keep a pool from being edited like a fan-out group.
 *
 * Requires the full stack running (see README.md).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BEE_UPLOADER,
  RUNGS,
  apiRaw,
  beePublishers,
  cleanup,
  createGroup,
  getProfile,
  listGroupMembers,
  requireStack,
  uniqueName,
} from './helpers.js';

const BATCH = (seed: string) => seed.replace(/\D/g, '').padEnd(64, '0');

const created = new Set<string>();
const track = (name: string): string => {
  created.add(name);
  return name;
};
/** A pool's members are `<pool>-<rung>`; removing all four drops the group. */
const trackPool = (pool: string): string => {
  for (const rung of RUNGS) track(`${pool}-${rung}`);
  return pool;
};

before(requireStack);
after(async () => {
  await cleanup(created);
});

describe('ABR node pool', () => {
  it('creates one bee-uploader per rung, named <pool>-<rung>', async () => {
    const pool = trackPool(uniqueName('pool'));

    const { group, profiles } = await createGroup({
      group_name: pool,
      size: 1, // ignored for a pool — the ladder fixes the size
      kind: 'custom',
      abr_ladder: true,
      notes: 'pool',
    });

    assert.equal(group.kind, 'abr-node-pool');
    assert.equal(group.size, RUNGS.length);
    assert.equal(profiles.length, RUNGS.length);

    const members = await listGroupMembers(group.id);
    assert.deepEqual(
      members.map((m) => m.name).sort(),
      RUNGS.map((r) => `${pool}-${r}`).sort(),
    );

    for (const member of members) {
      assert.deepEqual(member.components, [BEE_UPLOADER], `${member.name} components`);
      // A rung runs no stream-uploader, so it is never "pending" a stamp even
      // though it very much needs one before it can publish.
      assert.equal(member.pendingStamp, false, `${member.name} pendingStamp`);
      assert.equal(member.status, 'STOPPED', `${member.name} status`);
      assert.equal(member.group_id, group.id);
    }
  });

  it('withholds BEE_PUBLISHERS and names every rung that is not ready', async () => {
    const pool = trackPool(uniqueName('pool'));
    const { group } = await createGroup({
      group_name: pool,
      size: 1,
      kind: 'custom',
      abr_ladder: true,
    });

    const result = await beePublishers(group.id);
    assert.equal(result.ready, false);
    assert.equal(result.value, null, 'no partial string while rungs are unready');
    assert.deepEqual(
      result.missing.map((m) => m.rung).sort(),
      [...RUNGS].sort(),
      'every rung is stopped and unstamped, so every rung blocks',
    );
    for (const note of result.missing) {
      assert.ok(note.reason.length > 0, `${note.rung} should say why`);
    }
  });

  it('refuses one stamp for the whole pool at creation', async () => {
    // The create path used to accept this and write the same batch to all four
    // rungs — the exact state the update path below refuses.
    const { status, body } = await apiRaw('POST', '/groups', {
      group_name: uniqueName('pool'),
      size: 1,
      kind: 'custom',
      abr_ladder: true,
      stamp_id: BATCH('360'),
    });
    assert.equal(status, 409);
    assert.equal((body as { error: string }).error, 'ladder_group_invalid_operation');
    assert.match((body as { message: string }).message, /own postage batch/);
  });

  it('refuses a bulk stamp edit and refuses appending members', async () => {
    const pool = trackPool(uniqueName('pool'));
    const { group } = await createGroup({
      group_name: pool,
      size: 1,
      kind: 'custom',
      abr_ladder: true,
    });

    const stamped = await apiRaw('PATCH', `/groups/${group.id}/config`, {
      stamp_id: BATCH('480'),
    });
    assert.equal(stamped.status, 409);
    assert.equal(
      (stamped.body as { error: string }).error,
      'ladder_group_invalid_operation',
    );

    const appended = await apiRaw('POST', `/groups/${group.id}/members`, {
      count: 1,
    });
    assert.equal(appended.status, 409);
    assert.equal(
      (appended.body as { error: string }).error,
      'ladder_group_invalid_operation',
    );

    // Still exactly the four rungs.
    assert.equal((await listGroupMembers(group.id)).length, RUNGS.length);
  });

  it('still allows the edits that are safe across a pool', async () => {
    const pool = trackPool(uniqueName('pool'));
    const { group } = await createGroup({
      group_name: pool,
      size: 1,
      kind: 'custom',
      abr_ladder: true,
      notes: 'before',
    });

    const patched = await apiRaw('PATCH', `/groups/${group.id}/config`, {
      notes: 'after',
    });
    // Assert the PATCH succeeded. Without this a 409 or 500 would go
    // unreported, and the loop below would then be checking nothing.
    assert.ok(
      patched.status >= 200 && patched.status < 300,
      `PATCH /groups/${group.id}/config -> ${patched.status}: ${JSON.stringify(patched.body)}`,
    );

    const members = await listGroupMembers(group.id);
    // listGroupMembers filters the profile list on `group_id`, which comes out
    // of PROFILE_COLUMNS. Drop that column and every group_id is undefined,
    // `members` is empty, the loop body never runs and this test passes having
    // proved nothing about bulk propagation. Pin the count first.
    assert.equal(
      members.length,
      RUNGS.length,
      `expected ${RUNGS.length} rungs, got ${members.length}`,
    );
    for (const m of members) {
      assert.equal((await getProfile(m.name)).notes, 'after');
    }
  });

  it('rejects a pool name too long for <pool>-1080p to fit', async () => {
    // Profile names cap at 31 and the longest rung is `1080p`, so a pool caps
    // at 25 — caught at the edge rather than as a constraint violation with two
    // members already inserted.
    const { status, body } = await apiRaw('POST', '/groups', {
      group_name: 'a'.repeat(26),
      size: 1,
      kind: 'custom',
      abr_ladder: true,
    });
    assert.equal(status, 400);
    assert.match(JSON.stringify(body), /at most 25 characters/);
  });

  it('has no BEE_PUBLISHERS to assemble for an ordinary fan-out group', async () => {
    const name = uniqueName('fanout');
    const { group } = await createGroup({
      group_name: name,
      size: 2,
      kind: 'custom',
      components: [BEE_UPLOADER],
    });
    for (let i = 1; i <= 2; i += 1) track(`${name}-profile-${i}`);

    assert.equal(group.kind, 'standard');
    const { status, body } = await apiRaw(
      'GET',
      `/groups/${group.id}/bee-publishers`,
    );
    assert.equal(status, 409);
    assert.match((body as { message: string }).message, /not an ABR node pool/);
  });
});
