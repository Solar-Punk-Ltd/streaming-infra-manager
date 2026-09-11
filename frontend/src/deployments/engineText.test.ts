/**
 * The engine in one line, tested without a browser.
 *
 * Unit test, no DOM. `pnpm test` in frontend/.
 *
 * The line names what the manager says the engine runs with, so it agrees
 * with the engine card and the settings drawer on the same page. A key the
 * deployment's own config file dropped is said to be missing rather than
 * filled with a number nothing reads.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { engineSummary } from './engineText';

const known = (value: string) => ({ status: 'known', source: 'deployment', value, environment: 'all' } as const);

describe('the engine in one line', () => {
  it('names what the manager says the engine runs with', () => {
    assert.equal(
      engineSummary('srs', { HLS_FRAGMENT: known('0.5'), HLS_WINDOW: known('15') }),
      'SRS · segment 0.5 s · window 15 s',
    );
  });

  it('distinguishes an omitted field from an unverified one', () => {
    assert.equal(
      engineSummary('srs', { HLS_FRAGMENT: known('0.5'), HLS_WINDOW: {
        status: 'unknown', source: 'omitted', value: null, reason: 'missing-directive', environment: 'none',
      } }),
      'SRS · segment 0.5 s · window not specified',
    );
    assert.equal(engineSummary('srs', {}), 'SRS · segment unverified · window unverified');
  });

  it('reads OvenMediaEngine the same way', () => {
    assert.equal(
      engineSummary('ome', { HLS_SEGMENT_DURATION: known('2'), HLS_SEGMENT_COUNT: known('5') }),
      'OvenMediaEngine · segment 2 s · playlist 5 pieces',
    );
  });

  it('uses the observed literal regardless of a stored override elsewhere', () => {
    assert.equal(engineSummary('ome', { HLS_SEGMENT_DURATION: {
      status: 'known', source: 'config-file', value: '4', environment: 'none',
    }, HLS_SEGMENT_COUNT: known('8') }), 'OvenMediaEngine · segment 4 s · playlist 8 pieces');
  });
});
