/**
 * ABR uploader integration tests.
 *
 * An `abr-uploader` publishes to an ABR node pool: `srs + stream-uploader`, no
 * Bee node, and no postage of its own. The validation cases run against a
 * synthetic ladder and start nothing; the one deploy case needs real, funded
 * rungs and is skipped unless `ABR_BEE_PUBLISHERS` names them —
 *
 *   ABR_BEE_PUBLISHERS='360p@http://host:10055<batch> …' pnpm test:integration
 *
 * so no live batch id is ever committed here. Requires the full stack (README).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BEE_UPLOADER,
  RUNGS,
  SRS,
  STREAM_UPLOADER,
  apiRaw,
  cleanup,
  createProfile,
  getProfileOrNull,
  removeProfile,
  requireStack,
  serviceNames,
  stopProfile,
  uniqueName,
  waitForGone,
  waitForRunningServices,
  waitForStatus,
  waitForUploaderHealthy,
} from './helpers.js';

const DEPLOY_TIMEOUT = 240_000;

/** Structurally valid and unreachable — enough for every validation case. */
const SYNTHETIC = RUNGS.map(
  (rung, i) =>
    `${rung}@http://10.0.0.9:${10015 + i * 10}<${rung.replace(/\D/g, '').padEnd(64, '0')}>`,
).join(' ');

const LIVE = process.env.ABR_BEE_PUBLISHERS?.trim();

// A throwaway key for the local stack: the uploader requires STREAM_KEY and
// derives its catalog feed's owner from it. Deliberately not a real one.
const TEST_KEY = `0x${'11'.repeat(32)}`;

const created = new Set<string>();
const track = (name: string): string => {
  created.add(name);
  return name;
};

before(requireStack);
after(async () => {
  await cleanup(created);
});

describe('ABR uploader — validation', () => {
  const rejects = async (body: Record<string, unknown>, re: RegExp) => {
    const { status, body: got } = await apiRaw('POST', '/profiles', {
      name: uniqueName('abrup'),
      kind: 'abr-uploader',
      private_key: TEST_KEY,
      ...body,
    });
    assert.equal(status, 400, `expected 400, got ${status}: ${JSON.stringify(got)}`);
    assert.match(JSON.stringify(got), re);
  };

  it('requires BEE_PUBLISHERS — without it nothing would ever be published', async () => {
    await rejects({}, /bee_publishers is required/);
  });

  it('requires a private key — the uploader cannot start without STREAM_KEY', async () => {
    const { status, body } = await apiRaw('POST', '/profiles', {
      name: uniqueName('abrup'),
      kind: 'abr-uploader',
      bee_publishers: SYNTHETIC,
    });
    assert.equal(status, 400);
    assert.match(JSON.stringify(body), /private_key is required/);
  });

  it('names the rung a paste is missing', async () => {
    await rejects(
      { bee_publishers: SYNTHETIC.split(' ').slice(1).join(' ') },
      /missing 360p/,
    );
  });

  it('rejects a duplicated rung', async () => {
    await rejects(
      { bee_publishers: `${SYNTHETIC} ${SYNTHETIC.split(' ')[0]}` },
      /360p appears twice/,
    );
  });

  it('rejects addresses an uploader elsewhere could not use', async () => {
    await rejects(
      { bee_publishers: SYNTHETIC.replace('360p@http://', '360p@http://deploy@') },
      /ssh user info/,
    );
    await rejects(
      { bee_publishers: SYNTHETIC.replace('720p@http://10.0.0.9', '720p@http://localhost') },
      /points at localhost/,
    );
  });

  it('rejects a shape that is not rung@url<batch>', async () => {
    await rejects({ bee_publishers: 'not-a-ladder' }, /rung@http/);
  });
});

describe('bee_url — an external node for a single-node uploader', () => {
  it('is accepted when the deployment runs no bee-uploader', async () => {
    // This one really is created and deployed, so it is tracked for teardown.
    const name = track(uniqueName('beeurl'));
    const { status, body } = await apiRaw('POST', '/profiles', {
      name,
      kind: 'custom',
      components: [SRS],
      bee_url: 'http://10.0.0.7:1633',
    });
    assert.equal(status, 202, JSON.stringify(body));
    assert.equal((body as { bee_url: string }).bee_url, 'http://10.0.0.7:1633');
    await waitForRunningServices(name, [SRS], { timeoutMs: DEPLOY_TIMEOUT });
  });

  it('is refused where deploy.sh would overwrite it', async () => {
    const { status, body } = await apiRaw('POST', '/profiles', {
      name: uniqueName('beeurl'),
      kind: 'streamer',
      bee_url: 'http://10.0.0.7:1633',
    });
    assert.equal(status, 400);
    assert.match(JSON.stringify(body), /runs no bee-uploader/);
  });

  it('is refused alongside bee_publishers', async () => {
    const { status, body } = await apiRaw('POST', '/profiles', {
      name: uniqueName('beeurl'),
      kind: 'abr-uploader',
      bee_publishers: SYNTHETIC,
      bee_url: 'http://10.0.0.7:1633',
    });
    assert.equal(status, 400);
    assert.match(JSON.stringify(body), /not used when bee_publishers is set/);
  });
});

describe('ABR uploader — deploy against real rungs', () => {
  it(
    'deploys srs + stream-uploader, no bee node, no stamp pending',
    { skip: LIVE ? false : 'set ABR_BEE_PUBLISHERS to a funded ladder to run this' },
    async () => {
      const name = track(uniqueName('abrup'));

      const profile = await createProfile({
        name,
        kind: 'abr-uploader',
        bee_publishers: LIVE!,
        private_key: TEST_KEY,
        notes: 'live ladder',
      });
      assert.equal(profile.kind, 'abr-uploader');
      assert.equal(profile.bee_publishers, LIVE);

      const running = await waitForRunningServices(name, [SRS, STREAM_UPLOADER], {
        timeoutMs: DEPLOY_TIMEOUT,
      });

      // The whole point: the uploader came up with no stamp of its own and no
      // Bee node — it publishes to the pool's rungs.
      assert.equal(running.pendingStamp, false);
      assert.equal(running.stamp_id, null);
      assert.ok(
        !serviceNames(running).includes(BEE_UPLOADER),
        'an ABR uploader must not run a bee-uploader',
      );

      // The assertion that actually proves the deployment works. RUNNING alone
      // does not: it is also what a crash-looping uploader reports. If
      // BEE_PUBLISHERS had not reached the container the uploader would fall
      // back to BEE_URL, fail to resolve it, and restart forever right here.
      await waitForUploaderHealthy(running);

      await stopProfile(name);
      await waitForStatus(name, 'STOPPED', { timeoutMs: DEPLOY_TIMEOUT });
      await removeProfile(name);
      await waitForGone(name);
      assert.equal(await getProfileOrNull(name), null);
    },
  );
});
