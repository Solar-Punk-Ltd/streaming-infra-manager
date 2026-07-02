/**
 * Profile lifecycle integration tests — happy path.
 *
 * Each test creates a real deployment via the API, waits for it to actually
 * come up, asserts the right components are present, then exercises
 * modify / stop / remove. Requires the full stack running (see README.md).
 *
 * Run:  MANAGER_URL=http://localhost:9876 pnpm --filter @streaming-infra-manager/api test:integration
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BEE_GATEWAY,
  BEE_UPLOADER,
  CLIENT,
  FEED_OWNER_A,
  FEED_OWNER_B,
  SRS,
  cleanup,
  createProfile,
  getProfileOrNull,
  removeProfile,
  requireStack,
  serviceNames,
  stopProfile,
  updateProfile,
  uniqueName,
  waitForGone,
  waitForStatus,
} from './helpers.js';

// Real Docker deploys need headroom; helper waits throw on timeout so a hung
// deploy fails with a useful message instead of blocking forever.
const DEPLOY_TIMEOUT = 240_000;

const created = new Set<string>();
const track = (name: string): string => {
  created.add(name);
  return name;
};

before(requireStack);
// Safety net: remove anything a failed test left behind.
after(async () => {
  await cleanup(created);
});

describe('profile lifecycle (create → verify → modify → stop → remove)', () => {
  it('viewer: deploys client + bee-gateway, then modifies feed, stops and removes', async () => {
    const name = track(uniqueName('viewer'));

    // POST /profiles auto-deploys.
    const created0 = await createProfile({
      name,
      kind: 'viewer',
      feed_owner: FEED_OWNER_A,
      notes: 'initial',
    });
    assert.equal(created0.kind, 'viewer');

    const running = await waitForStatus(name, 'RUNNING', {
      timeoutMs: DEPLOY_TIMEOUT,
    });
    assert.deepEqual(
      serviceNames(running),
      [BEE_GATEWAY, CLIENT],
      'viewer should deploy exactly client + bee-gateway',
    );
    assert.equal(running.pendingStamp, false);
    assert.equal(running.feed_owner, FEED_OWNER_A);
    for (const c of running.containers) {
      assert.ok(
        Object.keys(c.ports).length > 0,
        `container ${c.service} should expose at least one port`,
      );
    }

    // MODIFY: change feed target + notes → redeploys.
    await updateProfile(name, { notes: 'updated', feed_owner: FEED_OWNER_B });
    const modified = await waitForStatus(name, 'RUNNING', {
      timeoutMs: DEPLOY_TIMEOUT,
    });
    assert.equal(modified.feed_owner, FEED_OWNER_B);
    assert.equal(modified.notes, 'updated');
    assert.deepEqual(serviceNames(modified), [BEE_GATEWAY, CLIENT]);

    // STOP.
    await stopProfile(name);
    await waitForStatus(name, 'STOPPED', { timeoutMs: DEPLOY_TIMEOUT });

    // REMOVE.
    await removeProfile(name);
    await waitForGone(name);
    assert.equal(await getProfileOrNull(name), null);
  });

  it('streamer: deploys srs + bee-uploader with stream-uploader held back (no stamp)', async () => {
    const name = track(uniqueName('streamer'));

    await createProfile({ name, kind: 'streamer', notes: 'initial' });

    const running = await waitForStatus(name, 'RUNNING', {
      timeoutMs: DEPLOY_TIMEOUT,
    });
    assert.deepEqual(
      serviceNames(running),
      [BEE_UPLOADER, SRS],
      'streamer without a stamp should deploy srs + bee-uploader and hold back stream-uploader',
    );
    assert.equal(
      running.pendingStamp,
      true,
      'streamer without a stamp should be pendingStamp',
    );

    await updateProfile(name, { notes: 'updated' });
    const modified = await waitForStatus(name, 'RUNNING', {
      timeoutMs: DEPLOY_TIMEOUT,
    });
    assert.equal(modified.notes, 'updated');

    await stopProfile(name);
    await waitForStatus(name, 'STOPPED', { timeoutMs: DEPLOY_TIMEOUT });
    await removeProfile(name);
    await waitForGone(name);
    assert.equal(await getProfileOrNull(name), null);
  });

  it('custom: deploys exactly the chosen components, then stops and removes', async () => {
    const name = track(uniqueName('custom'));
    const components = [SRS, BEE_UPLOADER];

    await createProfile({ name, kind: 'custom', components, notes: 'initial' });

    const running = await waitForStatus(name, 'RUNNING', {
      timeoutMs: DEPLOY_TIMEOUT,
    });
    const expected = [...components].sort();
    assert.deepEqual(
      serviceNames(running),
      expected,
      'custom profile should deploy exactly its chosen components',
    );
    assert.deepEqual([...(running.components ?? [])].sort(), expected);

    await stopProfile(name);
    await waitForStatus(name, 'STOPPED', { timeoutMs: DEPLOY_TIMEOUT });
    await removeProfile(name);
    await waitForGone(name);
    assert.equal(await getProfileOrNull(name), null);
  });
});
