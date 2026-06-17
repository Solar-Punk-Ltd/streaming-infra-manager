import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BLOCK_TIME_SECONDS, stampCostPlur, stampTtlSeconds } from './stampCost.js';

describe('stampTtlSeconds', () => {
  it('computes seconds as (amount / price) blocks × block time', () => {
    // 24000 / 24000 = 1 block → 5s
    assert.equal(stampTtlSeconds('24000', '24000'), 5);
    // 240000 / 24000 = 10 blocks → 50s
    assert.equal(stampTtlSeconds('240000', '24000'), 50);
  });

  it('floors only once, at the end (multiply before divide)', () => {
    // 3 × 5 = 15, / 2 = 7 (not (3/2)=1 × 5 = 5)
    assert.equal(stampTtlSeconds('3', '2'), 7);
  });

  it('returns 0 when amount buys less than one block of life', () => {
    // 1 × 5 = 5, / 24000 = 0
    assert.equal(stampTtlSeconds('1', '24000'), 0);
  });

  it('returns null for missing or zero/negative price', () => {
    assert.equal(stampTtlSeconds('24000', null), null);
    assert.equal(stampTtlSeconds('24000', undefined), null);
    assert.equal(stampTtlSeconds('24000', '0'), null);
    assert.equal(stampTtlSeconds('24000', '-5'), null);
  });

  it('returns null for invalid amount', () => {
    assert.equal(stampTtlSeconds('', '24000'), null);
    assert.equal(stampTtlSeconds('0', '24000'), null);
    assert.equal(stampTtlSeconds('1.5', '24000'), null);
    assert.equal(stampTtlSeconds('abc', '24000'), null);
    assert.equal(stampTtlSeconds('-10', '24000'), null);
  });

  it('tolerates surrounding whitespace', () => {
    assert.equal(stampTtlSeconds(' 24000 ', ' 24000 '), 5);
  });

  it('handles large amounts that stay within safe-integer range', () => {
    // price 1 → seconds = amount × 5. Pick amount so result is large but safe.
    const amount = (1_000_000_000_000n).toString(); // 1e12 × 5 = 5e12, safe
    assert.equal(stampTtlSeconds(amount, '1'), 5_000_000_000_000);
  });

  it('returns null when the result exceeds Number.MAX_SAFE_INTEGER', () => {
    // amount × 5 / 1 must exceed MAX_SAFE_INTEGER (~9.007e15)
    const amount = (2_000_000_000_000_000n).toString(); // ×5 = 1e16 > MAX_SAFE
    assert.ok(2_000_000_000_000_000 * 5 > Number.MAX_SAFE_INTEGER);
    assert.equal(stampTtlSeconds(amount, '1'), null);
  });

  it('exports a block time of 5 seconds', () => {
    assert.equal(BLOCK_TIME_SECONDS, 5n);
  });
});

describe('stampCostPlur', () => {
  it('computes amount × 2^depth as a decimal string', () => {
    assert.equal(stampCostPlur('1', 0), '1');
    assert.equal(stampCostPlur('1', 17), (1n << 17n).toString()); // 131072
    assert.equal(stampCostPlur('24000', 20), (24000n * (1n << 20n)).toString());
  });

  it('handles depth 40 without precision loss (BigInt, not Number)', () => {
    // 2^40 = 1099511627776; × 1000000 overflows Number safe range
    assert.equal(stampCostPlur('1000000', 40), '1099511627776000000');
  });

  it('returns null for invalid amount', () => {
    assert.equal(stampCostPlur('', 17), null);
    assert.equal(stampCostPlur('0', 17), null);
    assert.equal(stampCostPlur('1.5', 17), null);
    assert.equal(stampCostPlur('abc', 17), null);
  });

  it('returns null for missing or invalid depth', () => {
    assert.equal(stampCostPlur('1', null), null);
    assert.equal(stampCostPlur('1', undefined), null);
    assert.equal(stampCostPlur('1', 1.5), null);
    assert.equal(stampCostPlur('1', -1), null);
  });
});
