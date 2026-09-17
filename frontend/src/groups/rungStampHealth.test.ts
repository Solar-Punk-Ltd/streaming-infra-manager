import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BeePublishersResult, LadderRungState } from '@streaming-infra-manager/common';

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

const poolResult = (rungs: LadderRungState[]): BeePublishersResult => ({
  ready: false,
  value: null,
  rungs,
  missing: [],
  warnings: [],
});

describe('the stamp reading a pool result already carries', () => {
  it('takes a batch the manager reports live, with its remaining time', () => {
    assert.deepEqual(rungStampHealth(rung({ stampState: 'active', stampTtl: 500_000 })), {
      state: 'active',
      ok: true,
      dead: false,
      ttl: 500_000,
    });
  });

  it('keeps a batch the manager reports beyond saving beyond saving', () => {
    for (const state of ['expired', 'gone'] as const) {
      const health = rungStampHealth(rung({ stampState: state, stampTtl: 0 }));
      assert.equal(health?.dead, true, state);
      assert.equal(health?.ok, false, state);
    }
  });

  it('calls a batch still settling neither usable nor dead', () => {
    const health = rungStampHealth(rung({ stampState: 'pending', stampTtl: 100 }));

    assert.equal(health?.ok, false);
    assert.equal(health?.dead, false);
  });

  it('says a rung with no batch has none', () => {
    assert.equal(rungStampHealth(rung({ stampId: null }))?.state, 'none');
  });

  it('gives no reading where the manager got none either', () => {
    assert.equal(rungStampHealth(rung({ stampState: 'unknown' })), undefined);
    assert.equal(rungStampHealth(rung()), undefined);
    assert.equal(rungStampHealth(null), undefined);
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
    );

    assert.deepEqual([...healths.keys()], ['abr-pool-1-360p', 'abr-pool-1-480p']);
    assert.equal(healths.get('abr-pool-1-360p')?.ok, true);
    assert.equal(healths.get('abr-pool-1-480p')?.dead, true);
  });
});
