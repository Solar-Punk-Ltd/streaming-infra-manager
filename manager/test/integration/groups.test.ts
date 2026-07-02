/**
 * Group config-edit integration test (Feature A) — happy path.
 *
 * Creates a small viewer group, deploys the members, then changes the shared
 * feed target for the WHOLE group in one call and asserts every member picks
 * up the new value and stays up. Group size is kept small (2) on purpose — this
 * runs on a laptop, not a server. Requires the full stack running (see README).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BEE_GATEWAY,
  CLIENT,
  FEED_OWNER_A,
  FEED_OWNER_B,
  cleanup,
  createGroup,
  deployProfile,
  getProfileOrNull,
  listGroups,
  removeProfile,
  requireStack,
  serviceNames,
  updateGroupConfig,
  uniqueName,
  waitForGone,
  waitForGroupGone,
  waitForStatus,
} from './helpers.js';

const DEPLOY_TIMEOUT = 240_000;

const created = new Set<string>();
before(requireStack);
after(async () => {
  await cleanup(created);
});

describe('group config edit (Feature A): bulk feed change redeploys every member', () => {
  it('edits the whole group feed_owner and all members pick it up', async () => {
    const groupName = uniqueName('grp');

    // Group creation does NOT auto-deploy; members start STOPPED.
    const { group, profiles } = await createGroup({
      group_name: groupName,
      size: 2,
      kind: 'viewer',
      feed_owner: FEED_OWNER_A,
      notes: 'group',
    });
    assert.equal(profiles.length, 2, 'group should be created with 2 members');
    const memberNames = profiles.map((p) => p.name);
    memberNames.forEach((n) => created.add(n));
    for (const p of profiles) {
      assert.equal(p.status, 'STOPPED', 'new group members start STOPPED');
      assert.equal(p.group_id, group.id);
      assert.equal(p.feed_owner, FEED_OWNER_A);
    }

    // Deploy every member.
    await Promise.all(memberNames.map((n) => deployProfile(n)));
    const runningBeforeEdit = await Promise.all(
      memberNames.map((n) =>
        waitForStatus(n, 'RUNNING', { timeoutMs: DEPLOY_TIMEOUT }),
      ),
    );
    for (const m of runningBeforeEdit) {
      assert.deepEqual(serviceNames(m), [BEE_GATEWAY, CLIENT]);
      assert.equal(m.feed_owner, FEED_OWNER_A);
    }

    // THE FEATURE: change the shared feed target for the whole group at once.
    const result = await updateGroupConfig(group.id, {
      feed_owner: FEED_OWNER_B,
    });
    assert.equal(result.profiles.length, 2);

    const afterEdit = await Promise.all(
      memberNames.map((n) =>
        waitForStatus(n, 'RUNNING', { timeoutMs: DEPLOY_TIMEOUT }),
      ),
    );
    for (const m of afterEdit) {
      assert.equal(
        m.feed_owner,
        FEED_OWNER_B,
        `${m.name} should have the new group feed_owner`,
      );
      assert.deepEqual(
        serviceNames(m),
        [BEE_GATEWAY, CLIENT],
        `${m.name} should still be a full viewer after the group redeploy`,
      );
    }

    // Remove members; the group should auto-delete once its last member is gone.
    for (const n of memberNames) {
      await removeProfile(n);
      await waitForGone(n);
      assert.equal(await getProfileOrNull(n), null);
    }
    await waitForGroupGone(group.id);
    const groups = await listGroups();
    assert.ok(
      !groups.some((g) => g.id === group.id),
      'group should be auto-removed after its last member is deleted',
    );
  });
});
