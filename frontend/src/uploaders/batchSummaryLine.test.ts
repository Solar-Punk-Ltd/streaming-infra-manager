/**
 * How the top-up and dilute dialogs name the batch they change, so the
 * operator can see which one they are about to pay for and what state it is in.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { batchSummaryLine } from './batchSummaryLine';
import type { BeeStamp } from './stampApi';

/** The host's full 1080p batch of 2026-09-24. */
const hostBatch: BeeStamp = {
  batchID: '1a2b3c4d'.repeat(8),
  utilization: 128,
  usable: true,
  depth: 23,
  amount: '1000000000',
  bucketDepth: 16,
  blockNumber: 1,
  immutableFlag: true,
  exists: true,
  batchTTL: 2 * 86_400 + 3 * 3_600,
};

describe('the batch a change is about', () => {
  it('is summed up by its depth, its life left and how full its fullest bucket is', () => {
    assert.equal(
      batchSummaryLine(hostBatch),
      'Depth 23 · 2d 3h left · 100% full, 128 of 128 chunks in its fullest bucket',
    );
  });

  it('leaves out a fill the node did not report', () => {
    const { utilization: _unsaid, ...unsized } = hostBatch;

    assert.equal(batchSummaryLine(unsized as BeeStamp), 'Depth 23 · 2d 3h left');
  });
});
