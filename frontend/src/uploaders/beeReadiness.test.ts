import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BeeNodeObservation } from '@streaming-infra-manager/common';
import { beeReadinessView } from './beeReadiness';

const observation: BeeNodeObservation = { state: 'ready', observedAt: '2026-09-08T00:00:00.000Z', healthStatus: 'ok', readinessStatus: 'ready', version: '2.8.2', apiVersion: '8.1.0', chainProgress: null };
const observedAt = Date.parse(observation.observedAt);

describe('fresh Bee evidence on screen', () => {
  it('measures freshness from local receipt despite server clock skew', () => {
    for (const skew of [-60000, 60000]) {
      const shifted = { ...observation, observedAt: new Date(observedAt + skew).toISOString() };
      assert.equal(beeReadinessView(shifted, observedAt + 1000, false, observedAt).state, 'ready');
      assert.equal(beeReadinessView(shifted, observedAt + 30001, false, observedAt).state, 'stale');
    }
  });
  it('labels API readiness separately from publishing and timestamps the observation', () => {
    const view = beeReadinessView(observation, observedAt + 1000, false);
    assert.equal(view.state, 'ready');
    assert.equal(view.label, 'Bee API ready');
    assert.match(view.detail, /2026-09-08T00:00:00.000Z/);
    assert.doesNotMatch(view.detail, /uploads succeed|playable|within a minute/i);
  });

  it('invalidates old, future, malformed and refreshing observations', () => {
    for (const [value, now, refreshing] of [
      [observation, observedAt + 30001, false],
      [observation, observedAt - 1, false],
      [{ ...observation, observedAt: 'invalid' }, observedAt, false],
      [observation, observedAt + 1000, true],
    ] as const) {
      assert.equal(beeReadinessView(value, now, refreshing).state, 'stale');
    }
  });

  it('distinguishes unknown, unreachable, initializing and reported failure without invented progress', () => {
    assert.equal(beeReadinessView(null, observedAt, false).state, 'unknown');
    for (const state of ['unknown', 'unreachable', 'initializing', 'unhealthy'] as const) {
      const view = beeReadinessView({ ...observation, state }, observedAt, false);
      assert.equal(view.state, state);
      assert.doesNotMatch(view.detail, /%|minute|block [0-9]/i);
    }
    const withProgress = beeReadinessView({ ...observation, state: 'initializing', chainProgress: { block: 12, chainTip: 20 } }, observedAt, false);
    assert.match(withProgress.detail, /12.*20/);
  });
});
