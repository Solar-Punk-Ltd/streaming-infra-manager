/**
 * beeTargetProblem — is a profile's upload destination coherent?
 *
 * These rules used to live only as per-field yup tests on
 * `createProfileSchema`, where they could see only the fields in the request
 * body. `PUT /profiles/:name` carries neither `kind` nor `components`, so all
 * three passed silently on update. Stating them over a whole profile is what
 * lets one definition serve both paths.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ABR_UPLOADER_KIND,
  beeTargetProblem,
  managesOwnStamp,
  usesNodePool,
} from './stampGating.js';

const batch = (rung: string) => rung.replace(/\D/g, '').padEnd(64, '0');
const PUBLISHERS = ['360p', '480p', '720p', '1080p']
  .map((rung, i) => `${rung}@http://65.108.40.58:${10015 + i * 10}<${batch(rung)}>`)
  .join(' ');

const EXTERNAL = 'http://10.0.0.7:1633';

describe('beeTargetProblem', () => {
  it('accepts an abr-uploader that has its pool', () => {
    assert.equal(
      beeTargetProblem({ kind: ABR_UPLOADER_KIND, bee_publishers: PUBLISHERS }),
      null,
    );
  });

  it('refuses an abr-uploader with no pool at all', () => {
    // The state a partial PUT used to reach: bee_publishers omitted from the
    // body is cleared by the full-replace update, the next deploy writes no
    // BEE_PUBLISHERS/ABR_ENABLED/ABR_LADDER, and the uploader crash-loops on a
    // BEE_URL fallback while the manager reports RUNNING.
    assert.match(
      beeTargetProblem({ kind: ABR_UPLOADER_KIND }) ?? '',
      /bee_publishers is required for a abr-uploader/,
    );
    assert.match(
      beeTargetProblem({ kind: ABR_UPLOADER_KIND, bee_publishers: null }) ?? '',
      /bee_publishers is required/,
    );
    assert.match(
      beeTargetProblem({ kind: ABR_UPLOADER_KIND, bee_publishers: '   ' }) ?? '',
      /bee_publishers is required/,
    );
  });

  it('refuses bee_url next to bee_publishers — two answers to one question', () => {
    assert.match(
      beeTargetProblem({
        kind: ABR_UPLOADER_KIND,
        bee_publishers: PUBLISHERS,
        bee_url: EXTERNAL,
      }) ?? '',
      /not used when bee_publishers is set/,
    );
  });

  it('refuses bee_url where deploy.sh would overwrite it', () => {
    // A streamer's default services include bee-uploader, and resolve_bee_url
    // computes BEE_URL into an override file that outranks .env.<profile>
    // whenever a local node is enabled — so the stored value would never apply.
    assert.match(
      beeTargetProblem({ kind: 'streamer', bee_url: EXTERNAL }) ?? '',
      /runs no bee-uploader/,
    );
    assert.match(
      beeTargetProblem({
        kind: 'custom',
        components: ['srs', 'bee-uploader'],
        bee_url: EXTERNAL,
      }) ?? '',
      /runs no bee-uploader/,
    );
  });

  it('accepts bee_url on a deployment that runs no bee node', () => {
    assert.equal(
      beeTargetProblem({
        kind: 'custom',
        components: ['srs', 'stream-uploader'],
        bee_url: EXTERNAL,
      }),
      null,
    );
  });

  it('leaves kinds it has nothing to say about alone', () => {
    assert.equal(beeTargetProblem({ kind: 'viewer' }), null);
    assert.equal(beeTargetProblem({ kind: 'streamer' }), null);
    assert.equal(beeTargetProblem({ kind: 'custom', components: [] }), null);
    // A streamer publishing through a pool is unusual but not incoherent: it
    // runs its own node, and BEE_PUBLISHERS is what the uploader reads.
    assert.equal(
      beeTargetProblem({ kind: 'streamer', bee_publishers: PUBLISHERS }),
      null,
    );
  });

  it('reports the missing pool before anything else', () => {
    // Ordered by what has to be fixed first: an abr-uploader with neither a
    // pool nor a usable bee_url has one real problem, not two.
    assert.match(
      beeTargetProblem({ kind: ABR_UPLOADER_KIND, bee_url: EXTERNAL }) ?? '',
      /bee_publishers is required/,
    );
  });
});

describe('usesNodePool / managesOwnStamp — who the Uploaders tab shows', () => {
  it('excludes an abr-uploader: its batches are the pool\'s, bought per rung', () => {
    const profile = { kind: ABR_UPLOADER_KIND, bee_publishers: PUBLISHERS };
    assert.equal(usesNodePool(profile), true);
    // The reason for the exclusion: it runs no bee node, so a funding panel
    // here would poll an address nothing answers at.
    assert.equal(managesOwnStamp(profile), false);
  });

  it('still shows a profile that runs its own node, pool string or not', () => {
    // The exclusion used to key on BEE_PUBLISHERS alone, so a streamer given a
    // pool string vanished from the tab — even though it runs a bee-uploader
    // with its own wallet and batch, and that node became impossible to fund
    // until the field was cleared again.
    const streamer = { kind: 'streamer', bee_publishers: PUBLISHERS };
    assert.equal(usesNodePool(streamer), false);
    assert.equal(managesOwnStamp(streamer), true);

    const custom = {
      kind: 'custom',
      components: ['srs', 'stream-uploader', 'bee-uploader'],
      bee_publishers: PUBLISHERS,
    };
    assert.equal(usesNodePool(custom), false);
    assert.equal(managesOwnStamp(custom), true);
  });

  it('leaves the ordinary cases as they were', () => {
    // No pool string: nothing to exclude.
    assert.equal(usesNodePool({ kind: 'streamer' }), false);
    assert.equal(managesOwnStamp({ kind: 'streamer' }), true);
    // A bare rung is a Bee node only — funded from the tab, which is the whole
    // reason isBeeNodeOnly exists.
    assert.equal(managesOwnStamp({ kind: 'custom', components: ['bee-uploader'] }), true);
    // A viewer uploads nothing.
    assert.equal(managesOwnStamp({ kind: 'viewer' }), false);
  });
});
