/**
 * A stream-uploader that publishes to an ABR node pool needs no stamp of its own.
 *
 * Unit test — no database, no Docker, no bee. `pnpm test` in manager/.
 *
 * The pool's batches live on the pool's rungs, possibly under another manager on
 * another machine; all this manager holds is the pasted BEE_PUBLISHERS. So the
 * three places that gate an uploader on `stamp_id` — the deploy split, the
 * pendingStamp flag, and the schema — have to treat a set BEE_PUBLISHERS as
 * satisfying them, and the schema has to catch a bad paste here rather than let
 * the uploader discover it on the other machine.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from 'yup';

import { isPendingStamp, managesOwnStamp } from '@streaming-infra-manager/common';

import {
  createProfileSchema,
  updateProfileSchema,
} from '../../src/schemas/profile.js';
import { splitDeployableServices } from '../../src/domain/stampLogic.js';
import { ContainerRepository } from '../../src/domain/ContainerRepository.js';
import { DeploymentGroupRepository } from '../../src/domain/DeploymentGroupRepository.js';
import { DeploymentOrchestrator } from '../../src/domain/DeploymentOrchestrator.js';
import { LadderGroupError } from '../../src/domain/errors/index.js';
import { EventBus } from '../../src/domain/EventBus.js';
import { ProfileService } from '../../src/domain/ProfileService.js';
import { ProfileRepository } from '../../src/domain/ProfileRepository.js';
import { Profile } from '../../src/types/index.js';

const BATCH = (rung: string) => rung.replace(/\D/g, '').padEnd(64, '0');
const PUBLISHERS = ['360p', '480p', '720p', '1080p']
  .map((rung, i) => `${rung}@http://65.108.40.58:${10015 + i * 10}<${BATCH(rung)}>`)
  .join(' ');

const STREAMER = ['srs', 'stream-uploader', 'bee-uploader'];
// An abr-uploader's own service list: no bee-uploader, so no node of its own.
const ABR_UPLOADER = ['srs', 'stream-uploader'];

function streamer(over: Partial<Profile> = {}): Profile {
  return {
    name: 'stage',
    port_slot: 2,
    kind: 'streamer',
    notes: null,
    components: null,
    host: null,
    feed_owner: null,
    feed_topic: null,
    private_key: null,
    public_key: null,
    stamp_id: null,
    bee_publishers: null,
    bee_url: null,
    status: 'STOPPED',
    last_error: null,
    last_error_at: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    group_id: null,
    ...over,
  };
}

const rejects = async (promise: Promise<unknown>, re: RegExp) => {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ValidationError, 'expected a yup ValidationError');
    assert.match(err.errors.join('\n'), re);
    return true;
  });
};

describe('pool-backed uploader — deploy gating', () => {
  it('holds the uploader back with neither a stamp nor publishers', () => {
    const split = splitDeployableServices(streamer(), STREAMER);
    assert.deepEqual(split.heldBackForStamp, ['stream-uploader']);
    assert.deepEqual(split.deployNow, ['srs', 'bee-uploader']);
  });

  it('releases the uploader on BEE_PUBLISHERS alone', () => {
    const split = splitDeployableServices(
      streamer({ kind: 'abr-uploader', bee_publishers: PUBLISHERS }),
      ABR_UPLOADER,
    );
    assert.deepEqual(split.heldBackForStamp, []);
    assert.deepEqual(split.deployNow, ABR_UPLOADER);
  });

  it('is not pendingStamp while publishing to a pool', () => {
    assert.equal(isPendingStamp(streamer()), true);
    const pool = streamer({ kind: 'abr-uploader', bee_publishers: PUBLISHERS });
    assert.equal(isPendingStamp(pool), false);
    // Whitespace is not a value.
    assert.equal(
      isPendingStamp({ ...pool, bee_publishers: '  ' }),
      true,
    );
  });

  it('keeps a pool-backed uploader out of the Uploaders tab', () => {
    // It has no Bee node, so a funding panel here would point at nothing; its
    // batches are managed on the pool's own card.
    assert.equal(managesOwnStamp(streamer()), true);
    assert.equal(
      managesOwnStamp(streamer({ kind: 'abr-uploader', bee_publishers: PUBLISHERS })),
      false,
    );
    // A bee-only rung of the pool itself still belongs there.
    assert.equal(
      managesOwnStamp({ kind: 'custom', components: ['bee-uploader'] }),
      true,
    );
  });
});

describe('bee_url — an external node for a single-node uploader', () => {
  it('accepts one when the deployment runs no bee-uploader', async () => {
    const out = await createProfileSchema.validate({
      name: 'stage',
      kind: 'custom',
      components: ['srs', 'stream-uploader'],
      bee_url: 'http://10.0.0.7:1633',
    });
    assert.equal(out.bee_url, 'http://10.0.0.7:1633');
  });

  it('refuses one that deploy.sh would overwrite', async () => {
    // resolve_bee_url wins whenever a local bee-uploader is enabled, so storing
    // this would be storing a value that never applies.
    await rejects(
      createProfileSchema.validate({
        name: 'stage',
        kind: 'streamer',
        bee_url: 'http://10.0.0.7:1633',
      }),
      /only applies to a deployment that runs no bee-uploader/,
    );
  });

  it('refuses an ssh target or a non-URL', async () => {
    const bad = (bee_url: string) =>
      createProfileSchema.validate({
        name: 'stage',
        kind: 'custom',
        components: ['srs', 'stream-uploader'],
        bee_url,
      });
    await rejects(bad('deploy@10.0.0.7'), /bee_url: expected an http\(s\) URL/);
    await rejects(bad('http://deploy@10.0.0.7:1633'), /bee_url: this address carries ssh user info/);
  });

  it('refuses saying two different things about where uploads go', async () => {
    await rejects(
      createProfileSchema.validate({
        name: 'stage',
        kind: 'abr-uploader',
        bee_publishers: PUBLISHERS,
        bee_url: 'http://10.0.0.7:1633',
      }),
      /bee_url is not used when bee_publishers is set/,
    );
  });
});

describe('pool-backed uploader — schema', () => {
  it('accepts a pasted pool on an abr-uploader', async () => {
    const out = await createProfileSchema.validate({
      name: 'stage',
      kind: 'abr-uploader',
      bee_publishers: PUBLISHERS,
      private_key: `0x${'11'.repeat(32)}`,
    });
    assert.equal(out.bee_publishers, PUBLISHERS);
  });

  it('stores the canonical form of a four-line paste', async () => {
    // Copying the rungs out as four lines parses (the split is on /\s+/) and so
    // validated clean, but the raw value was what got stored and written — and
    // an .env.<profile> whose 2nd-4th lines are not KEY=VALUE makes compose
    // refuse the entire file. The schema canonicalises so stored == accepted.
    const out = await createProfileSchema.validate({
      name: 'stage',
      kind: 'abr-uploader',
      bee_publishers: PUBLISHERS.split(' ').join('\n'),
      private_key: `0x${'11'.repeat(32)}`,
    });
    assert.equal(out.bee_publishers, PUBLISHERS);
  });

  it('stores an 0x-prefixed batch id without the prefix', async () => {
    // The uploader tests the un-stripped slice against /^[0-9a-fA-F]{64}$/ and
    // throws `must be 64 hex characters, got 66`. stamp_id is routinely
    // 0x-prefixed here, so this string is easy to hand-assemble.
    const prefixed = ['360p', '480p', '720p', '1080p']
      .map(
        (rung, i) =>
          `${rung}@http://65.108.40.58:${10015 + i * 10}<0x${BATCH(rung).toUpperCase()}>`,
      )
      .join(' ');
    const out = await createProfileSchema.validate({
      name: 'stage',
      kind: 'abr-uploader',
      bee_publishers: prefixed,
      private_key: `0x${'11'.repeat(32)}`,
    });
    assert.equal(out.bee_publishers, PUBLISHERS);
  });

  it('canonicalises on update as well as create', async () => {
    const out = await updateProfileSchema.validate({
      bee_publishers: PUBLISHERS.split(' ').join('\n'),
    });
    assert.equal(out.bee_publishers, PUBLISHERS);
  });

  it('requires the pool on an abr-uploader — without it nothing is published', async () => {
    await rejects(
      createProfileSchema.validate({ name: 'stage', kind: 'abr-uploader' }),
      /bee_publishers is required for a abr-uploader/,
    );
  });

  it('requires a private key — it is the uploader\'s STREAM_KEY', async () => {
    // The uploader declares `streamKey: required('STREAM_KEY')`; without one it
    // throws at config load and restarts forever while the manager, which only
    // watches the deploy script's exit code, reports RUNNING.
    await rejects(
      createProfileSchema.validate({
        name: 'stage',
        kind: 'abr-uploader',
        bee_publishers: PUBLISHERS,
      }),
      /private_key is required for a abr-uploader/,
    );
  });

  it('names the rung a bad paste is missing', async () => {
    await rejects(
      createProfileSchema.validate({
        name: 'stage',
        kind: 'abr-uploader',
        bee_publishers: PUBLISHERS.split(' ').slice(1).join(' '),
      }),
      /bee_publishers: missing 360p/,
    );
  });

  it('rejects a rung whose address is an ssh target or loopback', async () => {
    const ssh = PUBLISHERS.replace('360p@http://65.108.40.58', '360p@http://deploy@65.108.40.58');
    await rejects(
      createProfileSchema.validate({ name: 'stage', kind: 'abr-uploader', bee_publishers: ssh }),
      /360p: the address carries ssh user info/,
    );
    const local = PUBLISHERS.replace('480p@http://65.108.40.58', '480p@http://localhost');
    await rejects(
      createProfileSchema.validate({ name: 'stage', kind: 'abr-uploader', bee_publishers: local }),
      /480p: the address points at localhost/,
    );
  });

  it('rejects the OME engine at creation', async () => {
    await rejects(
      createProfileSchema.validate({
        name: 'stage',
        kind: 'custom',
        components: ['ome', 'stream-uploader'],
        bee_publishers: PUBLISHERS,
      }),
      /srs engine/,
    );
  });

  it('lets an update clear the field with null', async () => {
    const out = await updateProfileSchema.validate({ bee_publishers: null });
    assert.equal(out.bee_publishers, null);
  });
});

describe('creating a node pool — the stamp guard', () => {
  /**
   * POST and PATCH have to agree. updateGroupConfig refuses one stamp across a
   * pool because the rungs deliberately buy different-sized batches; createGroup
   * applied `shared` to every member and had no such guard, so the state PATCH
   * refused to produce could be created outright.
   */
  const service = () =>
    new ProfileService(
      {} as ProfileRepository,
      {} as ContainerRepository,
      {} as DeploymentOrchestrator,
      new EventBus(),
      {} as DeploymentGroupRepository,
    );

  const create = (over: Record<string, unknown> = {}) =>
    service().createGroup({
      group_name: 'stage',
      size: 4,
      kind: 'custom' as const,
      abr_ladder: true,
      ...over,
    });

  it('refuses one stamp for the whole pool', async () => {
    await assert.rejects(create({ stamp_id: BATCH('360p') }), (err: unknown) => {
      assert.ok(err instanceof LadderGroupError);
      assert.match(err.message, /each rung buys its own postage batch/);
      return true;
    });
  });

  it('does not stand in the way of an ordinary fan-out group', async () => {
    // Reaches the repository (undefined here) rather than being refused, which
    // is all this asserts: the guard is pool-only.
    await assert.rejects(
      create({ abr_ladder: false, stamp_id: BATCH('360p') }),
      (err: unknown) => !(err instanceof LadderGroupError),
    );
  });
});
