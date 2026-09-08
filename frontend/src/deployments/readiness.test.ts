import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stampHealthFrom } from '@streaming-infra-manager/common';

import type { Profile } from '../types';
import { buildChecklist, firstBlocker, type ChecklistInput } from './checklist';
import { readinessFor, readinessOf } from './readiness';
import { readySummary } from './readySummary';

export const runningProfile: Profile = {
  name: 'test-stream', kind: 'streamer', port_slot: 1, notes: null,
  status: 'RUNNING', last_error: null, last_error_at: null,
  created_at: '2026-09-08T00:00:00Z', updated_at: '2026-09-08T00:00:00Z',
  engine_settings: {}, has_engine_config: false, engine_config_error: null,
  containers: [{ service: 'srs', ports: {} }, { service: 'bee-uploader', ports: {} }],
};

function input(overrides: Partial<ChecklistInput> = {}): ChecklistInput {
  return {
    profile: runningProfile, wallet: { nativeTokenBalance: '1', bzzBalance: '1' },
    chequebook: { state: 'empty', availablePlur: 0n, floorPlur: 5000000000000000n },
    nodeAddress: '0x123', stampHealth: stampHealthFrom(null, null),
    currentStamp: null, publishUrl: 'srt://example.test:1234', clientUrl: null,
    streamers: [], ...overrides,
  };
}

describe('one readiness blocker', () => {
  it('puts funding before the missing stamp in the headline and primary action', () => {
    const state = input();
    const steps = buildChecklist(state);
    const first = firstBlocker(steps);
    assert.equal(first?.title, 'Bee node funded');
    assert.equal(readinessFor(state).label, first?.problem);
    assert.equal(first?.action?.kind, 'fill-chequebook');
    assert.deepEqual(steps.filter((step) => step.action?.primary), [first]);
    assert.match(readySummary(state).title, /chequebook empty/i);
  });

  it('requires verified chequebook funding before a new uploader action', () => {
    const state = input({ chequebook: null, stampHealth: { state: 'active', ok: true, dead: false, ttl: 500000 }, profile: { ...runningProfile, stamp_id: 'batch' } });
    const steps = buildChecklist(state);
    assert.equal(firstBlocker(steps)?.problem, 'Funding not checked');
    assert.equal(firstBlocker(steps)?.action?.kind, 'refresh-node');
    assert.equal(steps.some((step) => step.action?.kind === 'deploy-uploader'), false);
  });

  it('does not call a recorded stamp and running containers ready or playable', () => {
    const profile = { ...runningProfile, stamp_id: 'batch', containers: [...runningProfile.containers, { service: 'stream-uploader', ports: {} }] };
    assert.doesNotMatch(readinessOf(profile).label, /ready|watchable|playable/i);
    const viewer = { ...profile, kind: 'viewer' as const, components: ['client'], feed_owner: '0x123' };
    const summary = readySummary(input({ profile: viewer, clientUrl: 'http://example.test' }));
    assert.match(summary.title, /playback.*not verified/i);
    assert.equal(summary.url, 'http://example.test');
  });

  it('offers the stamp as the next primary action after verified funding', () => {
    const state = input({ chequebook: { state: 'ok', availablePlur: 10000000000000000n, floorPlur: 5000000000000000n } });
    const first = firstBlocker(buildChecklist(state));
    assert.equal(first?.action?.kind, 'buy-stamp');
    assert.equal(readinessFor(state).label, 'Needs a stamp');
  });
});
