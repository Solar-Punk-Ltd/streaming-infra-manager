/**
 * What diluting or topping up a batch leaves it with, worked out before anybody
 * pays for either.
 *
 * The host's numbers are the 1080p rung of the tester's pool on 2026-09-24: an
 * immutable batch of depth 23 over 16 bucket bits, which is 128 chunks a
 * bucket, whose fullest bucket held all 128, with two days and three hours
 * left. bee refused every upload that landed in that bucket.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dilutionPreview, type StampReading, topUpPreview } from './stampChanges.js';
import { MAX_STAMP_DEPTH, minimumStampAmountPlur, stampCostPlur } from './stampCost.js';
import { fullestBucketFillRatio } from './stampHealth.js';

const HOUR = 3_600;
const DAY = 24 * HOUR;
const HOST_TTL = 2 * DAY + 3 * HOUR;

const hostBatch = (over: Partial<StampReading> = {}): StampReading => ({
  depth: 23,
  bucketDepth: 16,
  utilization: 128,
  batchTTL: HOST_TTL,
  ...over,
});

describe('diluting a batch', () => {
  it('takes the host’s full batch to half full at depth 24', () => {
    assert.equal(fullestBucketFillRatio(hostBatch()), 1, 'the batch is full before');

    const after = dilutionPreview(hostBatch(), 24);

    assert.equal(after?.fillRatio, 0.5);
    assert.equal(after?.bucketChunks, 256);
    assert.equal(after?.chunks, 2 ** 24);
  });

  it('doubles what the batch and each bucket hold for every step, and keeps the fullest bucket’s count', () => {
    const after = dilutionPreview(hostBatch(), 25);

    assert.equal(after?.chunks, 33_554_432);
    assert.equal(after?.bucketChunks, 512);
    assert.equal(after?.fillRatio, 0.25);
  });

  it('halves the life left for every step, because the same balance pays for twice the chunks', () => {
    assert.equal(dilutionPreview(hostBatch(), 24)?.ttl, HOST_TTL / 2);
    assert.equal(dilutionPreview(hostBatch(), 25)?.ttl, Math.floor(HOST_TTL / 4));
  });

  it('is no dilution at the batch’s own depth or a shallower one', () => {
    assert.equal(dilutionPreview(hostBatch(), 23), null);
    assert.equal(dilutionPreview(hostBatch(), 22), null);
  });

  it('stops at the deepest depth this manager offers', () => {
    assert.ok(dilutionPreview(hostBatch(), MAX_STAMP_DEPTH));
    assert.equal(dilutionPreview(hostBatch(), MAX_STAMP_DEPTH + 1), null);
  });

  it('takes whole depths only', () => {
    assert.equal(dilutionPreview(hostBatch(), 24.5), null);
    assert.equal(dilutionPreview(hostBatch({ depth: 23.5 }), 24), null);
  });

  it('needs the batch’s own depth, which it cannot guess', () => {
    const { depth: _unsaid, ...unsized } = hostBatch();

    assert.equal(dilutionPreview(unsized, 24), null);
  });

  it('says nothing about the life after where the node did not say the life left', () => {
    assert.equal(dilutionPreview(hostBatch({ batchTTL: -1 }), 24)?.ttl, null);
    assert.equal(dilutionPreview(hostBatch({ batchTTL: undefined }), 24)?.ttl, null);
  });

  it('keeps a spent batch spent', () => {
    assert.equal(dilutionPreview(hostBatch({ batchTTL: 0 }), 24)?.ttl, 0);
  });

  it('says when the life after is under the day the postage contract refuses a dilution below', () => {
    assert.equal(dilutionPreview(hostBatch(), 24)?.underMinimumValidity, false, 'a day and an hour and a half');
    assert.equal(dilutionPreview(hostBatch(), 25)?.underMinimumValidity, true, 'twelve hours and three quarters');
    assert.equal(dilutionPreview(hostBatch({ batchTTL: 0 }), 24)?.underMinimumValidity, true, 'spent');
  });

  it('takes a day exactly, which the contract accepts, and refuses a second less', () => {
    assert.equal(dilutionPreview(hostBatch({ batchTTL: 2 * DAY }), 24)?.underMinimumValidity, false);
    assert.equal(dilutionPreview(hostBatch({ batchTTL: 2 * DAY - 2 }), 24)?.underMinimumValidity, true);
  });

  it('leaves it to the contract where the node did not say the life left', () => {
    assert.equal(dilutionPreview(hostBatch({ batchTTL: -1 }), 24)?.underMinimumValidity, false);
    assert.equal(dilutionPreview(hostBatch({ batchTTL: undefined }), 24)?.underMinimumValidity, false);
  });

  it('says nothing about buckets where the node did not report its bucket depth', () => {
    const { bucketDepth: _unsaid, ...unbucketed } = hostBatch();
    const after = dilutionPreview(unbucketed, 24);

    assert.equal(after?.chunks, 2 ** 24);
    assert.equal(after?.bucketChunks, null);
    assert.equal(after?.fillRatio, null);
  });
});

/** The price on the host on 2026-09-13, when a day of life cost 1,571,927,040 PLUR a chunk. */
const HOST_PRICE = '90968';
const ONE_DAY_AT_HOST_PRICE = '1571927040';

describe('topping up a batch', () => {
  it('adds the life the amount buys at today’s price to the life left', () => {
    const after = topUpPreview(hostBatch(), ONE_DAY_AT_HOST_PRICE, HOST_PRICE);

    assert.equal(minimumStampAmountPlur(HOST_PRICE), ONE_DAY_AT_HOST_PRICE, 'that amount is a day');
    assert.equal(after.addedTtl, DAY);
    assert.equal(after.ttl, HOST_TTL + DAY);
  });

  it('costs the amount for every chunk the batch holds, which is stampCostPlur', () => {
    const after = topUpPreview(hostBatch(), ONE_DAY_AT_HOST_PRICE, HOST_PRICE);

    assert.equal(after.costPlur, (1_571_927_040n * 2n ** 23n).toString());
    assert.equal(after.costPlur, stampCostPlur(ONE_DAY_AT_HOST_PRICE, 23));
  });

  it('still names the cost where the price is not known, and no life', () => {
    const after = topUpPreview(hostBatch(), ONE_DAY_AT_HOST_PRICE, null);

    assert.equal(after.addedTtl, null);
    assert.equal(after.ttl, null);
    assert.equal(after.costPlur, stampCostPlur(ONE_DAY_AT_HOST_PRICE, 23));
  });

  it('says what the amount adds but no total where the node did not say the life left', () => {
    const after = topUpPreview(hostBatch({ batchTTL: -1 }), ONE_DAY_AT_HOST_PRICE, HOST_PRICE);

    assert.equal(after.addedTtl, DAY);
    assert.equal(after.ttl, null);
  });

  it('says nothing for an amount that is not a positive whole number of PLUR', () => {
    for (const amount of ['', '0', '1.5', '-5', 'a day']) {
      assert.deepEqual(
        topUpPreview(hostBatch(), amount, HOST_PRICE),
        { addedTtl: null, ttl: null, costPlur: null },
        amount,
      );
    }
  });

  it('names no cost where the node did not report the depth', () => {
    const { depth: _unsaid, ...unsized } = hostBatch();

    assert.equal(topUpPreview(unsized, ONE_DAY_AT_HOST_PRICE, HOST_PRICE).costPlur, null);
  });
});
