/**
 * Group resize integration tests (Feature B).
 *
 * 1. Happy path: grow a group (new member inherits the group's shared config),
 *    deploy the whole grown group, then shrink it back down — asserting `size`
 *    stays in sync and the group auto-deletes once its last member is removed.
 * 2. Edge case: removing a middle member frees its `-profile-N` index, and the
 *    next add reuses that index (profile-2) rather than jumping to profile-4.
 *
 * Kept to 3 members max (laptop, not a server). Requires the full stack running.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BEE_GATEWAY,
  CLIENT,
  FEED_OWNER_A,
  addGroupMembers,
  cleanup,
  createGroup,
  deployProfile,
  getGroup,
  listGroupMembers,
  removeProfile,
  requireStack,
  uniqueName,
  waitForGone,
  waitForGroupGone,
  waitForGroupSize,
  waitForRunningServices,
  waitForStatus,
} from './helpers.js';

const DEPLOY_TIMEOUT = 240_000;

const created = new Set<string>();
before(requireStack);
after(async () => {
  await cleanup(created);
});

describe('group resize (Feature B): grow, size-sync, shrink, auto-delete', () => {
  it('adds a member that inherits config, deploys the grown group, then shrinks', async () => {
    // Start with a 2-viewer group (members created STOPPED).
    const { group, profiles } = await createGroup({
      group_name: uniqueName('grp'),
      size: 2,
      kind: 'viewer',
      feed_owner: FEED_OWNER_A,
    });
    profiles.forEach((p) => created.add(p.name));
    assert.equal(group.size, 2);

    // GROW: add one member; it inherits the group's shared config.
    const grown = await addGroupMembers(group.id, 1);
    assert.equal(grown.group.size, 3, 'size should sync up to 3');
    assert.equal(grown.profiles.length, 1);
    const added = grown.profiles[0]!;
    created.add(added.name);
    assert.equal(added.status, 'STOPPED', 'new member is created stopped');
    assert.equal(added.kind, 'viewer');
    assert.equal(
      added.feed_owner,
      FEED_OWNER_A,
      'new member inherits the group feed_owner',
    );
    assert.equal(added.group_id, group.id);
    assert.equal((await listGroupMembers(group.id)).length, 3);

    // Deploy every member — confirms the grown group is fully deployable.
    const names = (await listGroupMembers(group.id)).map((m) => m.name);
    await Promise.all(names.map((n) => deployProfile(n)));
    const running = await Promise.all(
      names.map((n) =>
        waitForRunningServices(n, [BEE_GATEWAY, CLIENT], {
          timeoutMs: DEPLOY_TIMEOUT,
        }),
      ),
    );
    for (const m of running) {
      assert.equal(m.feed_owner, FEED_OWNER_A);
    }

    // SHRINK: remove one member — group survives, size syncs down to 2.
    await removeProfile(added.name);
    await waitForGone(added.name);
    created.delete(added.name);
    await waitForGroupSize(group.id, 2);
    assert.equal((await listGroupMembers(group.id)).length, 2);
    assert.notEqual(await getGroup(group.id), null, 'group should still exist');

    // Remove the rest — the now-empty group auto-deletes.
    for (const m of await listGroupMembers(group.id)) {
      await removeProfile(m.name);
      await waitForGone(m.name);
      created.delete(m.name);
    }
    await waitForGroupGone(group.id);
    assert.equal(await getGroup(group.id), null);
  });

  it('reuses a freed member index: remove the middle member, then a re-add fills profile-2 (not profile-4)', async () => {
    // Deploy a group of 3.
    const { group, profiles } = await createGroup({
      group_name: uniqueName('grp'),
      size: 3,
      kind: 'viewer',
      feed_owner: FEED_OWNER_A,
    });
    profiles.forEach((p) => created.add(p.name));
    assert.equal(group.size, 3);

    const p1 = `${group.name}-profile-1`;
    const p2 = `${group.name}-profile-2`;
    const p3 = `${group.name}-profile-3`;
    assert.deepEqual(
      profiles.map((p) => p.name).sort(),
      [p1, p2, p3].sort(),
      'members should be named profile-1..3',
    );

    await Promise.all([p1, p2, p3].map((n) => deployProfile(n)));
    await Promise.all(
      [p1, p2, p3].map((n) =>
        waitForStatus(n, 'RUNNING', { timeoutMs: DEPLOY_TIMEOUT }),
      ),
    );

    // Remove the SECOND member — only profile-1 and profile-3 should remain.
    await removeProfile(p2);
    await waitForGone(p2);
    created.delete(p2);
    await waitForGroupSize(group.id, 2);
    assert.deepEqual(
      (await listGroupMembers(group.id)).map((m) => m.name).sort(),
      [p1, p3].sort(),
      'only profile-1 and profile-3 remain',
    );

    // Add one member — it should fill the freed profile-2 slot, not become profile-4.
    const grown = await addGroupMembers(group.id, 1);
    assert.equal(grown.profiles.length, 1);
    const readded = grown.profiles[0]!;
    created.add(readded.name);
    assert.equal(
      readded.name,
      p2,
      'the freed index (profile-2) should be reused, not profile-4',
    );
    assert.equal(grown.group.size, 3);
    assert.deepEqual(
      (await listGroupMembers(group.id)).map((m) => m.name).sort(),
      [p1, p2, p3].sort(),
      'membership is exactly profile-1, profile-2, profile-3 (no profile-4)',
    );
  });
});
