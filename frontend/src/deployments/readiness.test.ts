import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stampHealthFrom } from '@streaming-infra-manager/common';

import type { Profile } from '../types';
import { buildChecklist, firstBlocker, type ChecklistInput } from './checklist';
import { readinessFor, readinessOf } from './readiness';
import { readySummary } from './readySummary';

export const runningProfile: Profile = {
  name: 'test-stream', kind: 'streamer', port_slot: 1, notes: null, notes_revision: 0,
  status: 'RUNNING', last_error: null, last_error_at: null, last_full_deploy_commit: null,
  created_at: '2026-09-08T00:00:00Z', updated_at: '2026-09-08T00:00:00Z',
  engine_settings: {}, has_engine_config: false, engine_config_error: null,
  engine_config_state: null, instance_id: '00000000-0000-4000-8000-000000000001',
  engine_config_revision: 0, intent_revision: 0,
  containers: [
    { service: 'srs', ports: {}, buildId: null, buildCommit: null },
    { service: 'bee-uploader', ports: {}, buildId: null, buildCommit: null },
  ],
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
  it('keeps stopping and removing summaries distinct from stopped', () => {
    for (const status of ['STOPPING', 'REMOVING'] as const) {
      const state = input({ profile: { ...runningProfile, status } });
      assert.doesNotMatch(readySummary(state).title, /stopped|start it/i);
      assert.match(readySummary(state).title.toLowerCase(), new RegExp(status.toLowerCase()));
    }
  });
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

  it('cannot enable a new uploader using otherwise valid readings while the Bee observation is stale', () => {
    const state = input({
      profile: { ...runningProfile, stamp_id: 'batch' },
      stampHealth: { state: 'active', ok: true, dead: false, ttl: 500000 },
      chequebook: { state: 'ok', availablePlur: 10000000000000000n, floorPlur: 5000000000000000n },
      nodeReadiness: { state: 'stale', label: 'Bee observation stale', detail: 'Previous check is stale.' },
    });
    assert.equal(readinessFor(state).label, 'Bee observation stale');
    assert.equal(firstBlocker(buildChecklist(state))?.action?.kind, 'refresh-node');
    assert.equal(buildChecklist(state).some(step => step.action?.kind === 'deploy-uploader'), false);
    assert.equal(state.profile.status, 'RUNNING');
  });

  it('does not blame passing funding and stamp checks when the earlier API or deployment checks block startup', () => {
    for (const status of ['RUNNING', 'DEPLOYING'] as const) {
      const state = input({
        profile: { ...runningProfile, status, stamp_id: 'batch' },
        stampHealth: { state: 'active', ok: true, dead: false, ttl: 500000 },
        chequebook: { state: 'ok', availablePlur: 10000000000000000n, floorPlur: 5000000000000000n },
        nodeReadiness: { state: 'stale', label: 'Bee observation stale', detail: 'Previous check is stale.' },
      });
      const steps = buildChecklist(state);
      assert.equal(steps.find(step => step.title === 'Bee node funded')?.state, 'ok');
      assert.equal(steps.find(step => step.title === 'Postage stamp set')?.state, 'ok');
      const uploader = steps.find(step => step.title === 'Uploader running');
      assert.equal(uploader?.action, undefined);
      assert.match(uploader?.detail ?? '', /earlier readiness checks/i);
      assert.doesNotMatch(uploader?.detail ?? '', /funding and the stamp can be verified/i);
    }
  });

  it('does not call a recorded stamp and running containers ready or playable', () => {
    const profile = { ...runningProfile, stamp_id: 'batch', containers: [...runningProfile.containers, { service: 'stream-uploader', ports: {}, buildId: null, buildCommit: null }] };
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
