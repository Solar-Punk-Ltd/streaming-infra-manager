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

import { fullestBucketFillRatio } from '@streaming-infra-manager/common';

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
});
