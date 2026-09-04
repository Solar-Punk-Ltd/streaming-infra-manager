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

/**
 * Poll until a profile leaves its transitional state.
 *
 * An update is refused with 409 profile_busy while a deploy is in flight, so a
 * PUT sent straight after the 202 tests nothing about the validation rules
 * below — it never reaches them. Which terminal state it lands in does not
 * matter here (a profile with unreachable rungs still reports RUNNING, because
 * the deploy script exits 0), only that it has stopped moving.
 */
async function waitForSettled(name: string, timeoutMs = 240_000) {
  const settled = ['RUNNING', 'STOPPED', 'ERROR'];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const profile = await getProfileOrNull(name);
    if (profile && settled.includes(profile.status)) return profile;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`timed out waiting for ${name} to settle`);
}

describe('the update path enforces the same rules as create', () => {
  // Every rule below is checked on create by createProfileSchema's per-field
  // tests. None of them could fire on update: PUT carries neither `kind` nor
  // `components`, so the yup tests that read `this.parent` saw nothing to
  // object to. ProfileService now applies beeTargetProblem to the state the
  // write would leave behind, which is the only place the rule can be
  // evaluated against a partial body.

  it('refuses a bee_url that PUT would store where deploy.sh overwrites it', async () => {
    // A profile that runs its own Bee node. resolve_bee_url computes BEE_URL
    // into an override file that outranks .env.<profile> whenever one is
    // enabled, so a stored value here would never apply — the create path has
    // always said so, and PUT used to accept it anyway.
    const name = track(uniqueName('beeurl'));
    const created = await apiRaw('POST', '/profiles', {
      name,
      kind: 'custom',
      components: [BEE_UPLOADER],
    });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    await waitForSettled(name);

    const { status, body } = await apiRaw('PUT', `/profiles/${name}`, {
      bee_url: 'http://10.0.0.7:1633',
    });
    assert.equal(
      status,
      400,
      `PUT accepted a bee_url it must refuse: ${JSON.stringify(body)}`,
    );
    assert.match(JSON.stringify(body), /runs no bee-uploader/);

    // And it really was not written.
    const after = await getProfileOrNull(name);
    assert.equal(after?.bee_url, null);
  });

  it('refuses a PUT that would leave an abr-uploader with no pool', async () => {
    // The dangerous one. PUT replaces every editable field, so a body that
    // omits bee_publishers cleared it — and the next deploy then wrote no
    // BEE_PUBLISHERS, ABR_ENABLED or ABR_LADDER at all. The uploader falls
    // back to BEE_URL, fails to resolve it and restarts forever, while the
    // manager reports RUNNING the whole time.
    const name = uniqueName('abrup');
    const created = await apiRaw('POST', '/profiles', {
      name,
      kind: 'abr-uploader',
      bee_publishers: SYNTHETIC,
      private_key: TEST_KEY,
    });
    // Structurally valid but unreachable rungs: accepted, and it will not come
    // up, which is fine — this test is about the update rule, not the deploy.
    assert.equal(created.status, 202, JSON.stringify(created.body));
    track(name);
    await waitForSettled(name);

    const { status, body } = await apiRaw('PUT', `/profiles/${name}`, {
      notes: 'just editing the notes',
    });
    assert.equal(
      status,
      400,
      `a PUT omitting bee_publishers silently cleared it: ${JSON.stringify(body)}`,
    );
    assert.match(JSON.stringify(body), /bee_publishers is required/);

    // The pool link survived the rejected write.
    const after = await getProfileOrNull(name);
    assert.equal(after?.bee_publishers, SYNTHETIC);
  });

  it('canonicalises a four-line paste rather than storing it verbatim', async () => {
    // A multi-line value parses (the split is on whitespace) and so validated
    // clean, but was written verbatim — and an .env.<profile> whose 2nd-4th
    // lines are not KEY=VALUE makes compose refuse the entire file.
    const name = uniqueName('abrup');
    const { status, body } = await apiRaw('POST', '/profiles', {
      name,
      kind: 'abr-uploader',
      bee_publishers: SYNTHETIC.split(' ').join('\n'),
      private_key: TEST_KEY,
    });
    assert.equal(status, 202, JSON.stringify(body));
    track(name);
    assert.equal((body as { bee_publishers: string }).bee_publishers, SYNTHETIC);
  });
});

describe('bee_url reaches the container', () => {
  // The assertion the original bee_url tests were missing. `is accepted when
  // the deployment runs no bee-uploader` deploys [srs] only — and
  // resolve_bee_url runs only for the uploader service, so it never fired and
  // the test passed while proving nothing about where BEE_URL pointed.
  //
  // It pointed at http://bee-uploader:<port>, a compose service this profile
  // does not run, because resolve_bee_url decided "is there a local Bee node"
  // from deploy/config.json — which the manager writes once at bootstrap,
  // never per profile. The uploader died on `getaddrinfo ENOTFOUND
  // bee-uploader` and restarted forever while the manager reported RUNNING.
  //
  // Asking the uploader's own /health is what separates the two, exactly as
  // for the pool-backed case.
  const rung = LIVE?.split(' ')[0];
  const beeUrl = rung?.slice(rung.indexOf('@') + 1, rung.indexOf('<'));
  const batch = rung?.slice(rung.indexOf('<') + 1, rung.indexOf('>'));

  it(
    'deploys srs + stream-uploader against an external Bee node and comes up healthy',
    {
      skip: LIVE
        ? false
        : 'set ABR_BEE_PUBLISHERS — its 360p rung is reused here as an external node',
    },
    async () => {
      const name = track(uniqueName('beeurl'));
      const profile = await createProfile({
        name,
        kind: 'custom',
        components: [SRS, STREAM_UPLOADER],
        bee_url: beeUrl,
        stamp_id: batch,
        private_key: TEST_KEY,
        notes: 'external bee node',
      });
      assert.equal(profile.bee_url, beeUrl);

      const running = await waitForRunningServices(name, [SRS, STREAM_UPLOADER], {
        timeoutMs: DEPLOY_TIMEOUT,
      });
      assert.ok(
        !serviceNames(running).includes(BEE_UPLOADER),
        'this deployment must run no bee-uploader — that is what makes bee_url apply',
      );

      // RUNNING alone does not distinguish a working uploader from one that is
      // restarting. If BEE_URL had been overridden to the compose service name
      // again, this is where it would fail.
      await waitForUploaderHealthy(running);

      await removeProfile(name);
      await waitForGone(name);
    },
  );
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
