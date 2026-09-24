/**
 * The postage batches the dev mock's nodes hold.
 *
 * Runs with the other suites here under `pnpm test:browser`, and needs no
 * browser: it reads the seeded state directly.
 *
 * bee's utilization is the chunk count of a batch's fullest bucket, so it never
 * exceeds what one bucket holds, and a batch at that count is full. The pages
 * read it that way since 2026-09-25, so a mock that reports more than a bucket
 * holds shows a batch over 100% full.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fullestBucketFillRatio, stampHealthFrom } from '@streaming-infra-manager/common';

import { seed, state } from '../dev/mock-seed.mjs';

seed();

const everyBatch = () =>
  [...state.nodes.entries()].flatMap(([name, entry]) => entry.stamps.map((stamp) => ({ name, stamp })));

describe('the batches the dev mock’s nodes hold', () => {
  it('fill no bucket past what one bucket holds', () => {
    for (const { name, stamp } of everyBatch()) {
      const ratio = fullestBucketFillRatio(stamp);
      assert.ok(
        ratio !== null && ratio <= 1,
        `${name} holds a batch of depth ${stamp.depth} whose fullest bucket counts ${stamp.utilization}`,
      );
    }
  });

  /**
   * The 2026-09-24 case: a pool rung whose recorded immutable batch filled, so
   * its node refused every upload while it still had days left. Seeded so the
   * full state, its alert and the Dilute remedy can be seen and tested offline.
   */
  it('hold one full immutable batch, recorded on the pool’s 720p rung', () => {
    const full = state.profiles
      .filter((profile) => stampHealthFrom(profile.stamp_id, state.nodes.get(profile.name)?.stamps ?? []).state === 'full')
      .map((profile) => profile.name);

    assert.deepEqual(full, ['abr-pool-1-720p']);
    const node = state.nodes.get('abr-pool-1-720p');
    assert.equal(node.stamps.length, 1);
    assert.equal(node.stamps[0].immutableFlag, true);
    assert.ok(node.stamps[0].batchTTL > 86_400, 'it has days left, and fills first');
  });
});
