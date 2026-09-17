import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BeePublishersResult, LadderRungState } from '@streaming-infra-manager/common';

import type { Profile } from '../types';
import { poolStampHealths, rungStampHealth } from './rungStampHealth';

const BATCH = `0x${'a'.repeat(64)}`;

const rung = (overrides: Partial<LadderRungState> = {}): LadderRungState => ({
  rung: '360p',
  name: 'abr-pool-1-360p',
  status: 'RUNNING',
  url: 'http://172.17.0.1:10055',
  stampId: BATCH,
  ...overrides,
});

const member = (name: string): Profile => ({
  name, kind: 'streamer', port_slot: 1, notes: null, notes_revision: 0,
  status: 'RUNNING', last_error: null, last_error_at: null, last_full_deploy_commit: null,
  created_at: '2026-09-15T00:00:00Z', updated_at: '2026-09-15T00:00:00Z',
  engine_settings: {}, has_private_key: false, has_srt_passphrase: false, has_engine_config: false,
  engine_config_error: null, engine_config_state: null, group_id: 1,
  instance_id: '00000000-0000-4000-8000-000000000004',
  engine_config_revision: 0, intent_revision: 0, stamp_id: BATCH,
  components: ['bee-uploader'],
  containers: [{ service: 'bee-uploader', ports: {}, buildId: null, buildCommit: null }],
});

const poolResult = (rungs: LadderRungState[]): BeePublishersResult => ({
  ready: false,
  value: null,
  rungs,
  missing: [],
  warnings: [],
});

describe('the stamp reading a pool result already carries', () => {
  it('takes a batch the manager reports live, with its remaining time', () => {
    assert.deepEqual(rungStampHealth(rung({ stampState: 'active', stampTtl: 500_000 }), BATCH), {
      state: 'active',
      ok: true,
      dead: false,
      ttl: 500_000,
    });
  });

  it('keeps a batch the manager reports beyond saving beyond saving', () => {
    for (const state of ['expired', 'gone'] as const) {
      const health = rungStampHealth(rung({ stampState: state, stampTtl: 0 }), BATCH);
      assert.equal(health?.dead, true, state);
      assert.equal(health?.ok, false, state);
    }
  });

  it('calls a batch still settling neither usable nor dead', () => {
    const health = rungStampHealth(rung({ stampState: 'pending', stampTtl: 100 }), BATCH);

    assert.equal(health?.ok, false);
    assert.equal(health?.dead, false);
  });

  it('says a rung with no batch has none', () => {
    assert.equal(rungStampHealth(rung({ stampId: null }), null)?.state, 'none');
  });

  it('gives no reading where the manager got none either', () => {
    assert.equal(rungStampHealth(rung({ stampState: 'unknown' }), BATCH), undefined);
    assert.equal(rungStampHealth(rung(), BATCH), undefined);
    assert.equal(rungStampHealth(null, BATCH), undefined);
  });

  it('gives no reading for a batch the member no longer records', () => {
    const justBought = `0x${'b'.repeat(64)}`;

    assert.equal(rungStampHealth(rung({ stampState: 'active', stampTtl: 9 }), justBought), undefined);
    assert.equal(rungStampHealth(rung({ stampId: null }), justBought), undefined);
  });

  it('matches the recorded batch however the two are spelled', () => {
    assert.equal(rungStampHealth(rung({ stampState: 'active', stampTtl: 9 }), BATCH.slice(2))?.ok, true);
  });

  it('keys every pool a page holds by the member the rung runs on', () => {
    const healths = poolStampHealths(
      new Map([
        [1, poolResult([
          rung({ stampState: 'active', stampTtl: 9 }),
          rung({ rung: '480p', name: 'abr-pool-1-480p', stampState: 'expired', stampTtl: 0 }),
          rung({ rung: '720p', name: 'abr-pool-1-720p', stampState: 'unknown' }),
        ])],
        [2, null],
      ]),
      ['abr-pool-1-360p', 'abr-pool-1-480p', 'abr-pool-1-720p'].map(member),
    );

    assert.deepEqual([...healths.keys()], ['abr-pool-1-360p', 'abr-pool-1-480p']);
    assert.equal(healths.get('abr-pool-1-360p')?.ok, true);
    assert.equal(healths.get('abr-pool-1-480p')?.dead, true);
  });
});
