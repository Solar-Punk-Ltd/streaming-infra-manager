import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatFillPercent,
  fullestBucketFillRatio,
  isDeadStampState,
  isFullestBucketFull,
  isStampExpired,
  isStampExpiringSoon,
  isStampNearlyFull,
  nearlyFullConsequence,
  STAMP_EXPIRY_WARNING_SECONDS,
  STAMP_FILL_WARNING_RATIO,
  sameBatchId,
  stampBucketCapacity,
  stampHealthFrom,
  stampStateReason,
  type StampLike,
} from './stampHealth.js';

const BATCH = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

const stamp = (over: Partial<StampLike> = {}): StampLike => ({
  batchID: BATCH,
  usable: true,
  batchTTL: 86_400,
  exists: true,
  ...over,
});

describe('stampHealthFrom', () => {
  it('reports none when nothing is recorded', () => {
    for (const id of [null, undefined, '', '   ']) {
      assert.equal(stampHealthFrom(id, [stamp()]).state, 'none');
    }
  });

  it('reports unknown while the node has not answered', () => {
    const health = stampHealthFrom(BATCH, null);
    assert.equal(health.state, 'unknown');
    // A node being down must never read as an expired batch.
    assert.equal(health.dead, false);
    assert.equal(health.ok, false);
  });

  it('reports active for a usable batch with time left', () => {
    const health = stampHealthFrom(BATCH, [stamp()]);
    assert.equal(health.state, 'active');
    assert.equal(health.ok, true);
    assert.equal(health.dead, false);
    assert.equal(health.ttl, 86_400);
  });

  it('reports expired once the TTL reaches zero', () => {
    const health = stampHealthFrom(BATCH, [stamp({ batchTTL: 0, usable: false })]);
    assert.equal(health.state, 'expired');
    assert.equal(health.dead, true);
    assert.equal(health.ok, false);
  });

  // The reported case: batches expired a week ago, so bee dropped them and the
  // stamps table came back empty while the profile still carried the id.
  it('reports gone when the node no longer lists the batch', () => {
    const health = stampHealthFrom(BATCH, []);
    assert.equal(health.state, 'gone');
    assert.equal(health.dead, true);
  });

  it('reports gone when the node lists only other batches', () => {
    assert.equal(stampHealthFrom(BATCH, [stamp({ batchID: OTHER })]).state, 'gone');
  });

  it('reports gone when the node says the batch no longer exists', () => {
    assert.equal(stampHealthFrom(BATCH, [stamp({ exists: false })]).state, 'gone');
  });

  it('reports pending for a batch bee has not settled yet', () => {
    const health = stampHealthFrom(BATCH, [stamp({ usable: false })]);
    assert.equal(health.state, 'pending');
    // Waiting fixes this one, so it is not dead.
    assert.equal(health.dead, false);
    assert.equal(health.ok, false);
  });

  it('treats an unknown TTL as alive, not expired', () => {
    // bee answers -1 when it cannot work the TTL out. Only 0 means spent.
    assert.equal(stampHealthFrom(BATCH, [stamp({ batchTTL: -1 })]).state, 'active');
  });

  it('matches a recorded id whether or not it carries 0x', () => {
    assert.equal(stampHealthFrom(`0x${BATCH}`, [stamp()]).state, 'active');
    assert.equal(
      stampHealthFrom(BATCH, [stamp({ batchID: `0x${BATCH}` })]).state,
      'active',
    );
  });
});

/**
 * What the 1080p rung of the tester's pool reported on 2026-09-24: depth 23 over
 * 16 bucket bits is 128 chunks a bucket, and its fullest bucket held all 128.
 * bee still called the batch usable with two days left, and refused every upload
 * that landed in that bucket with a 402.
 */
const hostBatch = (over: Partial<StampLike> = {}): StampLike =>
  stamp({
    depth: 23,
    bucketDepth: 16,
    utilization: 128,
    immutableFlag: true,
    batchTTL: 2 * 86_400 + 3 * 3_600,
    ...over,
  });

describe('stampHealthFrom, how full the batch is', () => {
  it('reports a full immutable batch as full, however much time it has left', () => {
    const health = stampHealthFrom(BATCH, [hostBatch()]);

    assert.equal(health.state, 'full');
    assert.equal(health.ok, false);
    // A full immutable batch can still be diluted, so it is not beyond saving.
    assert.equal(health.dead, false);
    assert.equal(health.ttl, 2 * 86_400 + 3 * 3_600);
    assert.equal(health.fillRatio, 1);
    assert.equal(health.immutable, true);
  });

  it('keeps a full mutable batch active, since bee overwrites rather than refusing', () => {
    const health = stampHealthFrom(BATCH, [hostBatch({ immutableFlag: false })]);

    assert.equal(health.state, 'active');
    assert.equal(health.ok, true);
    assert.equal(health.fillRatio, 1);
    assert.equal(health.immutable, false);
  });

  it('treats a batch whose immutability nobody reported as the kind that refuses', () => {
    const { immutableFlag: _unknown, ...unsaid } = hostBatch();
    const health = stampHealthFrom(BATCH, [unsaid]);

    assert.equal(health.state, 'full');
    assert.equal(health.immutable, null);
  });

  it('keeps a batch it cannot size active, rather than reading silence as empty or full', () => {
    const { utilization: _missing, ...unsized } = hostBatch();
    const health = stampHealthFrom(BATCH, [unsized]);

    assert.equal(health.state, 'active');
    assert.equal(health.fillRatio, null);
  });

  it('carries the fill of a batch with room left', () => {
    const health = stampHealthFrom(BATCH, [hostBatch({ utilization: 32 })]);

    assert.equal(health.state, 'active');
    assert.equal(health.fillRatio, 0.25);
    assert.equal(health.immutable, true);
  });

  it('reports expiry ahead of fill, because an expired batch is past saving', () => {
    const health = stampHealthFrom(BATCH, [hostBatch({ batchTTL: 0, usable: false })]);

    assert.equal(health.state, 'expired');
    assert.equal(health.dead, true);
  });

  it('reports a batch bee has not settled as pending, whatever its fill', () => {
    assert.equal(stampHealthFrom(BATCH, [hostBatch({ usable: false })]).state, 'pending');
  });

  it('carries no fill where nothing was read', () => {
    for (const health of [stampHealthFrom(null, [hostBatch()]), stampHealthFrom(BATCH, null), stampHealthFrom(BATCH, [])]) {
      assert.equal(health.fillRatio, null);
      assert.equal(health.immutable, null);
    }
  });
});

describe('fullestBucketFillRatio', () => {
  it('divides the fullest bucket by what one bucket holds', () => {
    assert.equal(fullestBucketFillRatio({ utilization: 128, depth: 23, bucketDepth: 16 }), 1);
    assert.equal(fullestBucketFillRatio({ utilization: 64, depth: 23, bucketDepth: 16 }), 0.5);
    assert.equal(fullestBucketFillRatio({ utilization: 0, depth: 17, bucketDepth: 16 }), 0);
  });

  it('answers null for a missing field, never an empty batch', () => {
    assert.equal(fullestBucketFillRatio({ depth: 23, bucketDepth: 16 }), null);
    assert.equal(fullestBucketFillRatio({ utilization: 128, bucketDepth: 16 }), null);
    assert.equal(fullestBucketFillRatio({ utilization: 128, depth: 23 }), null);
    assert.equal(fullestBucketFillRatio({}), null);
  });

  it('answers null for a field that is not a finite number', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, '128' as unknown as number]) {
      assert.equal(fullestBucketFillRatio({ utilization: bad, depth: 23, bucketDepth: 16 }), null, String(bad));
      assert.equal(fullestBucketFillRatio({ utilization: 1, depth: bad, bucketDepth: 16 }), null, String(bad));
      assert.equal(fullestBucketFillRatio({ utilization: 1, depth: 23, bucketDepth: bad }), null, String(bad));
    }
  });

  it('answers null when the batch is shallower than its buckets, which no batch can be', () => {
    assert.equal(fullestBucketFillRatio({ utilization: 1, depth: 15, bucketDepth: 16 }), null);
  });
});

describe('formatFillPercent', () => {
  it('rounds down, so a batch one chunk short of full never reads as full', () => {
    assert.equal(formatFillPercent(127 / 128), '99%');
    assert.equal(formatFillPercent(122 / 128), '95%');
    assert.equal(formatFillPercent(1), '100%');
    assert.equal(formatFillPercent(0), '0%');
  });
});

describe('isFullestBucketFull', () => {
  it('is true once the fullest bucket holds all it can, and only then', () => {
    assert.equal(isFullestBucketFull(1), true);
    assert.equal(isFullestBucketFull(127 / 128), false);
    assert.equal(isFullestBucketFull(null), false);
    assert.equal(isFullestBucketFull(undefined), false);
  });
});

describe('stampBucketCapacity', () => {
  it('is two to the depth the batch has beyond its buckets', () => {
    assert.equal(stampBucketCapacity({ depth: 23, bucketDepth: 16 }), 128);
    assert.equal(stampBucketCapacity({ depth: 16, bucketDepth: 16 }), 1);
    assert.equal(stampBucketCapacity({ depth: 15, bucketDepth: 16 }), null);
    assert.equal(stampBucketCapacity({ bucketDepth: 16 }), null);
  });
});

describe('isStampNearlyFull', () => {
  const past = 0.95;

  it('warns about an immutable batch past the uploader’s start ceiling', () => {
    assert.equal(isStampNearlyFull(past, true), true);
    assert.equal(isStampNearlyFull(STAMP_FILL_WARNING_RATIO + 0.001, true), true);
  });

  it('does not warn at the ceiling or below it', () => {
    // The uploader refuses a batch above the ceiling, not one at it.
    assert.equal(isStampNearlyFull(STAMP_FILL_WARNING_RATIO, true), false);
    assert.equal(isStampNearlyFull(0.5, true), false);
  });

  // bee never refuses a mutable batch, but once it fills it overwrites the
  // oldest chunks it paid for, and the uploader of stack v3.3 and earlier holds
  // it to the same start ceiling, so a restart on it past 90% is refused.
  it('warns about a mutable batch past the ceiling too, full or not', () => {
    assert.equal(isStampNearlyFull(past, false), true);
    assert.equal(isStampNearlyFull(1, false), true);
    assert.equal(isStampNearlyFull(STAMP_FILL_WARNING_RATIO, false), false);
  });

  it('warns about a batch whose immutability nobody reported', () => {
    assert.equal(isStampNearlyFull(past, null), true);
    assert.equal(isStampNearlyFull(past, undefined), true);
  });

  it('does not warn about a batch that is already full', () => {
    // Full is not a warning. It is a failure, and reported as one.
    assert.equal(isStampNearlyFull(1, true), false);
  });

  it('does not warn on a fill nobody could work out', () => {
    assert.equal(isStampNearlyFull(null, true), false);
    assert.equal(isStampNearlyFull(undefined, true), false);
  });
});

describe('nearlyFullConsequence', () => {
  it('says an immutable batch refuses a restart past 90% and uploads once full', () => {
    assert.match(nearlyFullConsequence(true), /Past 90% an uploader restarted on it refuses to start/);
    assert.match(nearlyFullConsequence(true), /once it fills its node refuses uploads/);
  });

  it('says a mutable batch overwrites once full, and which stacks refuse a restart on it', () => {
    assert.match(nearlyFullConsequence(false), /overwrites its oldest chunks/);
    assert.match(nearlyFullConsequence(false), /stack v3\.3 and earlier refuses to restart on it/);
  });

  // The tester's 720p batch reaches this within a few broadcast hours of 2026-09-24.
  it('says a full mutable batch is overwriting now, not once it fills', () => {
    const full = nearlyFullConsequence(false, 1);

    assert.match(full, /now overwrites its oldest chunks/);
    assert.match(full, /stack v3\.3 and earlier refuses to restart on it/);
    assert.doesNotMatch(full, /once it fills/i);
  });

  it('reads a batch of unreported kind as one that refuses', () => {
    assert.equal(nearlyFullConsequence(null), nearlyFullConsequence(true));
  });

  it('carries no em-dash or semicolon, being operator copy', () => {
    for (const kind of [true, false]) assert.doesNotMatch(nearlyFullConsequence(kind), /[—;]/);
  });
});

describe('isStampExpired', () => {
  it('is true at zero TTL and false above it', () => {
    assert.equal(isStampExpired(stamp({ batchTTL: 0 })), true);
    assert.equal(isStampExpired(stamp({ batchTTL: 1 })), false);
    assert.equal(isStampExpired(stamp({ batchTTL: -1 })), false);
  });
});

describe('sameBatchId', () => {
  it('ignores a leading 0x on either side', () => {
    assert.equal(sameBatchId(BATCH, `0x${BATCH}`), true);
    assert.equal(sameBatchId(`0x${BATCH}`, BATCH), true);
    assert.equal(sameBatchId(BATCH, OTHER), false);
  });
});

describe('stampStateReason', () => {
  it('explains every state that blocks publishing, and only those', () => {
    assert.ok(stampStateReason('none'));
    assert.ok(stampStateReason('expired'));
    assert.ok(stampStateReason('gone'));
    assert.ok(stampStateReason('pending'));
    assert.ok(stampStateReason('full'));
    assert.equal(stampStateReason('active'), null);
    assert.equal(stampStateReason('unknown'), null);
  });

  it('says a full batch makes its node refuse uploads, in words with no dash or semicolon', () => {
    const reason = stampStateReason('full')!;

    assert.match(reason, /full/);
    assert.match(reason, /refuses uploads/);
    assert.doesNotMatch(reason, /[—;]/);
  });
});

describe('isDeadStampState', () => {
  it('is true only for the states a new batch is the only cure for', () => {
    assert.equal(isDeadStampState('expired'), true);
    assert.equal(isDeadStampState('gone'), true);
    // Dilution buys a full batch room, so buying another is not the only cure.
    assert.equal(isDeadStampState('full'), false);
    assert.equal(isDeadStampState('active'), false);
    assert.equal(isDeadStampState('pending'), false);
    assert.equal(isDeadStampState('none'), false);
    // Unverified is not evidence of death. That is the whole point of the state.
    assert.equal(isDeadStampState('unknown'), false);
    assert.equal(isDeadStampState(undefined), false);
    assert.equal(isDeadStampState(null), false);
  });
});

describe('isStampExpiringSoon', () => {
  const soon = STAMP_EXPIRY_WARNING_SECONDS;

  it('warns inside the window and not outside it', () => {
    assert.equal(isStampExpiringSoon(soon - 1), true);
    assert.equal(isStampExpiringSoon(soon), true);
    assert.equal(isStampExpiringSoon(soon + 1), false);
  });

  it('does not warn about a batch that has already gone', () => {
    // Expiry is not a warning. It is a failure, and reported as one.
    assert.equal(isStampExpiringSoon(0), false);
  });

  it('does not warn on an unknown TTL', () => {
    // bee answers negative when it cannot work the TTL out. Short is not the
    // same as unknown.
    assert.equal(isStampExpiringSoon(-1), false);
    assert.equal(isStampExpiringSoon(null), false);
    assert.equal(isStampExpiringSoon(undefined), false);
  });

  it('takes a caller-supplied window', () => {
    assert.equal(isStampExpiringSoon(3_600, 7_200), true);
    assert.equal(isStampExpiringSoon(3_600, 1_800), false);
  });
});
