import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ABR_RUNG_COMPONENTS, BEE_GATEWAY_SERVICE, type ChequebookHealth, CLIENT_SERVICE,
  type StampHealth, stampHealthFrom, ULTRA_LIGHT_NODE_MODE } from '@streaming-infra-manager/common';

import type { Profile } from '../types';
import { buildChecklist, firstBlocker, type ChecklistInput } from './checklist';
import { CHEQUEBOOK_EMPTY, NEEDS_A_STAMP, needsAttention, readinessFor, readinessOf } from './readiness';
import { readySummary } from './readySummary';

export const runningProfile: Profile = {
  name: 'test-stream', kind: 'streamer', port_slot: 1, notes: null, notes_revision: 0,
  status: 'RUNNING', last_error: null, last_error_at: null, last_full_deploy_commit: null,
  created_at: '2026-09-08T00:00:00Z', updated_at: '2026-09-08T00:00:00Z',
  engine_settings: {}, has_private_key: false, has_srt_passphrase: false, has_engine_config: false, engine_config_error: null,
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

describe('a list that never reads a wallet', () => {
  const stamped: Profile = { ...runningProfile, stamp_id: `0x${'a'.repeat(64)}` };
  const fundingStepOf = (profile: Profile, chequebook?: ChequebookHealth | null) =>
    buildChecklist({
      ...input({ profile, wallet: undefined, chequebook: chequebook ?? null }),
      stampHealth: stampHealthFrom(profile.stamp_id, null),
    }).find((step) => step.title === 'Bee node funded');

  it('does not blame a running node for a reading nobody took', () => {
    assert.doesNotMatch(readinessOf(stamped).label, /funding not checked/i);
    assert.equal(needsAttention(stamped), false);
    assert.equal(fundingStepOf(stamped)?.state, 'busy');
  });

  it('calls funding checked once the node reports a chequebook it can pay from', () => {
    const paying: ChequebookHealth = { state: 'ok', availablePlur: 10_000_000_000_000_000n, floorPlur: 5_000_000_000_000_000n };

    assert.equal(fundingStepOf(stamped, paying)?.state, 'ok');
    assert.doesNotMatch(readinessOf(stamped, undefined, paying).label, /funding|chequebook/i);
  });

  it('counts a node whose chequebook the node itself reported empty', () => {
    const empty: ChequebookHealth = { state: 'empty', availablePlur: 0n, floorPlur: 5_000_000_000_000_000n };

    assert.equal(readinessOf(stamped, undefined, empty).label, CHEQUEBOOK_EMPTY);
    assert.equal(needsAttention(stamped, undefined, empty), true);
  });

  it('counts a node that answered the chequebook read with a failure, in its own words', () => {
    const unread: ChequebookHealth = {
      state: 'unknown', availablePlur: null, floorPlur: 5_000_000_000_000_000n,
      failure: { reason: 'timeout', elapsedMs: 3_012 },
    };

    assert.equal(readinessOf(stamped, undefined, unread).label, 'Node did not answer in time');
    assert.equal(needsAttention(stamped, undefined, unread), true);
  });

  it('still asks for a stamp a running node has never had', () => {
    const paying: ChequebookHealth = { state: 'ok', availablePlur: 10_000_000_000_000_000n, floorPlur: 5_000_000_000_000_000n };
    const unstamped: Profile = { ...runningProfile, stamp_id: null };

    assert.equal(readinessOf(unstamped, undefined, paying).label, NEEDS_A_STAMP);
    assert.equal(needsAttention(unstamped, undefined, paying), true);
  });

  it('does not count a node for a stamp reading nobody took', () => {
    const paying: ChequebookHealth = { state: 'ok', availablePlur: 10_000_000_000_000_000n, floorPlur: 5_000_000_000_000_000n };

    assert.equal(readinessOf(stamped, undefined, paying).label, 'Stamp not checked');
    assert.equal(needsAttention(stamped, undefined, paying), false);
  });

  it('keeps funding not checked for the page that did ask the node', () => {
    assert.equal(readinessFor(input({ profile: stamped, wallet: null, chequebook: null })).label, 'Funding not checked');
  });
});

describe('a pool member judged by the readings its page already holds', () => {
  const member: Profile = {
    ...runningProfile,
    name: 'abr-pool-1-360p',
    components: [...ABR_RUNG_COMPONENTS],
    containers: [{ service: 'bee-uploader', ports: {}, buildId: null, buildCommit: null }],
    stamp_id: `0x${'a'.repeat(64)}`,
  };
  const paying: ChequebookHealth = { state: 'ok', availablePlur: 10_000_000_000_000_000n, floorPlur: 5_000_000_000_000_000n };

  it('calls a funded rung whose batch the manager reports live ready', () => {
    const live: StampHealth = { state: 'active', ok: true, dead: false, ttl: 500_000 };

    assert.equal(readinessOf(member, live, paying).label, 'Node prerequisites checked');
    assert.equal(needsAttention(member, live, paying), false);
  });

  it('keeps the warning where the manager reports the batch gone', () => {
    const gone: StampHealth = { state: 'gone', ok: false, dead: true, ttl: null };

    assert.equal(readinessOf(member, gone, paying).label, 'Stamp not on node');
    assert.equal(needsAttention(member, gone, paying), true);
  });

  it('waits where the pool result has not arrived yet', () => {
    assert.equal(readinessOf(member, undefined, paying).label, 'Stamp not checked');
    assert.equal(needsAttention(member, undefined, paying), false);
  });
});

describe('a row that reads the wallet itself', () => {
  const member: Profile = {
    ...runningProfile,
    name: 'abr-pool-1-480p',
    components: [...ABR_RUNG_COMPONENTS],
    containers: [{ service: 'bee-uploader', ports: {}, buildId: null, buildCommit: null }],
    stamp_id: `0x${'a'.repeat(64)}`,
  };
  const live: StampHealth = { state: 'active', ok: true, dead: false, ttl: 500_000 };
  const paying: ChequebookHealth = { state: 'ok', availablePlur: 10_000_000_000_000_000n, floorPlur: 5_000_000_000_000_000n };

  it('judges as a list does while the wallet reading has not arrived', () => {
    assert.equal(readinessOf(member, live, paying, undefined).label, 'Node prerequisites checked');
  });

  it('says a spent wallet needs funding once the row has read it', () => {
    const spent = { nativeTokenBalance: '1000000000000000', bzzBalance: '0' };

    assert.equal(readinessOf(member, live, paying, spent).label, 'Node needs funding');
    assert.equal(readinessOf(member, live, paying, { nativeTokenBalance: '1', bzzBalance: '1' }).label, 'Node prerequisites checked');
  });

  it('keeps funding not checked for a row whose node did not answer', () => {
    assert.equal(readinessOf(member, live, paying, null).label, 'Funding not checked');
  });
});

describe('a standalone Bee node a list polled for its batch', () => {
  const standalone: Profile = {
    ...runningProfile,
    name: 'bee-1',
    components: [...ABR_RUNG_COMPONENTS],
    containers: [{ service: 'bee-uploader', ports: {}, buildId: null, buildCommit: null }],
    stamp_id: `0x${'a'.repeat(64)}`,
  };
  const paying: ChequebookHealth = { state: 'ok', availablePlur: 10_000_000_000_000_000n, floorPlur: 5_000_000_000_000_000n };

  it('warns and counts once the node says the batch has run out', () => {
    const expired: StampHealth = { state: 'expired', ok: false, dead: true, ttl: 0 };

    assert.equal(readinessOf(standalone, expired, paying).label, 'Stamp expired');
    assert.equal(needsAttention(standalone, expired, paying), true);
  });

  it('waits, and counts nothing, while it has no answer from that node', () => {
    assert.equal(readinessOf(standalone, undefined, paying).label, 'Stamp not checked');
    assert.equal(needsAttention(standalone, undefined, paying), false);
  });
});

describe('the readiness of a node that reaches no chain', () => {
  const gateway: Profile = {
    ...runningProfile,
    name: 'watch-eu',
    kind: 'viewer',
    components: [CLIENT_SERVICE, BEE_GATEWAY_SERVICE],
    containers: [
      { service: CLIENT_SERVICE, ports: {}, buildId: null, buildCommit: null },
      { service: BEE_GATEWAY_SERVICE, ports: {}, buildId: null, buildCommit: null },
      ],
    feed_owner: `0x${'1'.repeat(40)}`,
  };

  /**
   * An ultra-light node is asked for no gas and no postage, so a page that
   * read nothing off it is not a page that is missing a reading.
   */
  it('is not held up by balances a node with no chequebook cannot have', () => {
    assert.equal(readinessOf(gateway, undefined, null).label, 'Containers running');
    assert.equal(needsAttention(gateway, undefined, null), false);
  });

  it('is the same for an uploader node stored ultra-light', () => {
    const stranded: Profile = { ...runningProfile, node_mode: ULTRA_LIGHT_NODE_MODE };

    assert.equal(readinessOf(stranded, undefined, null).label, 'Containers running');
    assert.equal(needsAttention(stranded, undefined, null), false);
  });
});
