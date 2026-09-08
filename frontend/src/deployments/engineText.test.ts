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

describe('the engine in one line', () => {
  it('names what the manager says the engine runs with', () => {
    assert.equal(
      engineSummary('srs', { HLS_FRAGMENT: '0.5', HLS_WINDOW: '15' }),
      'SRS · segment 0.5 s · window 15 s',
    );
  });

  it('says a key the config file dropped is not in the file, rather than a number', () => {
    assert.equal(
      engineSummary('srs', { HLS_FRAGMENT: '0.5' }),
      'SRS · segment 0.5 s · window not in the file',
    );
  });

  it('reads OvenMediaEngine the same way', () => {
    assert.equal(
      engineSummary('ome', { HLS_SEGMENT_DURATION: '2', HLS_SEGMENT_COUNT: '5' }),
      'OvenMediaEngine · segment 2 s · playlist 5 pieces',
    );
  });
});
