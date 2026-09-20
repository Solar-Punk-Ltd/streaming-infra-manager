import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lifecycleReading } from '../../src/domain/UploaderLifecycleService.js';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const observedAt = '2026-09-20T00:00:10.000Z';

function payload(stream: Record<string, unknown>) {
  return { lifecycleVersion: 1, observedAt, streams: [stream] };
}

function stream(state: string, lastObservedAt = '2026-09-20T00:00:00.000Z') {
  return { adminStreamId: ADMIN_ID, runNumber: 2, state, lastObservedAt };
}

describe('uploader lifecycle response', () => {
  it('keeps only validated public lifecycle fields', () => {
    const reading = lifecycleReading(payload({ ...stream('live'), token: 'secret', checkpointPath: '/private/state', nested: { claimId: 'secret' } }), new Date(observedAt));
    assert.deepEqual(reading, { state: 'available', streams: [{ adminId: ADMIN_ID, runNumber: 2, state: 'live' }] });
    assert.doesNotMatch(JSON.stringify(reading), /secret|checkpoint|claim/i);
  });

  it('refuses malformed and unsupported payloads atomically', () => {
    assert.deepEqual(lifecycleReading({ lifecycleVersion: 2, observedAt, streams: [] }, new Date(observedAt)), { state: 'unavailable' });
    assert.deepEqual(lifecycleReading(payload({ ...stream('live'), adminStreamId: 'not-a-uuid' }), new Date(observedAt)), { state: 'unavailable' });
  });

  it('expires an active state by uploader observation age plus receipt elapsed time', () => {
    assert.deepEqual(lifecycleReading(payload(stream('waiting', '2026-09-19T23:59:39.000Z')), new Date(observedAt)), { state: 'unavailable' });
  });

  it('keeps closed and VOD facts after the active freshness window', () => {
    for (const state of ['closed', 'vod']) {
      assert.deepEqual(lifecycleReading(payload(stream(state)), new Date('2026-09-20T01:00:00.000Z')), { state: 'available', streams: [{ adminId: ADMIN_ID, runNumber: 2, state }] });
    }
  });
});
