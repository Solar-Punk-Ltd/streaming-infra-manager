/**
 * What a pool's own pill says, against readings the manager's pool string does
 * not carry.
 *
 * The manager assembles that string from stamps and reachability alone, so it
 * calls a pool with a dry rung ready. A rung that cannot pay its peers is still
 * listed in the string, and an uploader publishing to it lands nothing there.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ABR_NODE_POOL_GROUP_KIND,
  type BeePublishersResult,
  type ChequebookHealth,
} from '@streaming-infra-manager/common';

import type { DeploymentGroup, Profile } from '../types';
import type { ChequebookHealths } from '../uploaders/useChequebookHealths';
import { groupReadinessOf, poolProblems } from './groupReadiness';

const pool: DeploymentGroup = {
  id: 1,
  name: 'abr-pool-1',
  size: 4,
  kind: ABR_NODE_POOL_GROUP_KIND,
  created_at: '2026-09-15T00:00:00Z',
};

const member = (rung: string): Profile => ({
  name: `abr-pool-1-${rung}`, kind: 'streamer', port_slot: 1, notes: null, notes_revision: 0,
  status: 'RUNNING', last_error: null, last_error_at: null, last_full_deploy_commit: null,
  created_at: '2026-09-15T00:00:00Z', updated_at: '2026-09-15T00:00:00Z',
  engine_settings: {}, has_private_key: false, has_rpc_endpoint: false, has_srt_passphrase: false, has_engine_config: false,
  engine_config_error: null, engine_config_state: null, group_id: 1,
  instance_id: '00000000-0000-4000-8000-000000000003',
  engine_config_revision: 0, intent_revision: 0, components: ['bee-uploader'],
  containers: [{ service: 'bee-uploader', ports: {}, buildId: null, buildCommit: null }],
});

const members = ['360p', '480p', '720p', '1080p'].map(member);

const ready: BeePublishersResult = {
  ready: true,
  value: 'fixture-pool',
  rungs: members.map((profile, index) => ({
    rung: ['360p', '480p', '720p', '1080p'][index]!,
    name: profile.name,
    status: 'RUNNING',
    url: 'http://172.17.0.1:10055',
    stampId: `0x${'a'.repeat(64)}`,
    stampState: 'active' as const,
    urlState: 'ok' as const,
  })),
  missing: [],
  warnings: [],
};

const drained: ChequebookHealth = { state: 'empty', availablePlur: 0n, floorPlur: 5_000_000_000_000_000n };
const paying: ChequebookHealth = { state: 'ok', availablePlur: 10_000_000_000_000_000n, floorPlur: 5_000_000_000_000_000n };
const healths = (entries: [string, ChequebookHealth][]): ChequebookHealths => new Map(entries);

describe('the pill on a pool the manager calls ready', () => {
  it('calls it ready where every rung can still pay its peers', () => {
    const readings = healths(members.map((profile) => [profile.name, paying]));

    assert.deepEqual(groupReadinessOf(pool, members, ready, readings), {
      label: 'Pool ready',
      tone: 'ok',
    });
    assert.deepEqual(poolProblems(ready, readings), []);
  });

  it("refuses to call it ready while a rung cannot pay its peers", () => {
    const readings = healths([
      [members[0]!.name, paying],
      [members[1]!.name, drained],
      [members[2]!.name, paying],
      [members[3]!.name, paying],
    ]);

    assert.deepEqual(groupReadinessOf(pool, members, ready, readings), {
      label: 'Chequebook empty',
      tone: 'err',
    });
    assert.deepEqual(poolProblems(ready, readings), ['480p: chequebook empty']);
  });

  it('says nothing about a rung that did not answer', () => {
    const readings = healths([[members[0]!.name, paying]]);

    assert.equal(groupReadinessOf(pool, members, ready, readings).label, 'Pool ready');
    assert.deepEqual(poolProblems(ready, readings), []);
  });
});
