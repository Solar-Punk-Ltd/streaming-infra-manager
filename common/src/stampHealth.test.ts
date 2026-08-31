import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isDeadStampState,
  isStampExpired,
  isStampExpiringSoon,
  STAMP_EXPIRY_WARNING_SECONDS,
  sameBatchId,
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
    // bee answers -1 when it cannot work the TTL out; only 0 means spent.
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
    assert.equal(stampStateReason('active'), null);
    assert.equal(stampStateReason('unknown'), null);
  });
});

describe('isDeadStampState', () => {
  it('is true only for the states a new batch is the only cure for', () => {
    assert.equal(isDeadStampState('expired'), true);
    assert.equal(isDeadStampState('gone'), true);
    assert.equal(isDeadStampState('active'), false);
    assert.equal(isDeadStampState('pending'), false);
    assert.equal(isDeadStampState('none'), false);
    // Unverified is not evidence of death — that is the whole point of the state.
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
    // Expiry is not a warning — it is a failure, and reported as one.
    assert.equal(isStampExpiringSoon(0), false);
  });

  it('does not warn on an unknown TTL', () => {
    // bee answers negative when it cannot work the TTL out; short is not the
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
