/**
 * The ids a setting's row gives its field and the words that name it.
 *
 * Unit test, no browser. `pnpm test` in frontend/. The name a browser works out
 * from them is read in `frontend/test/deployment-settings-browser.test.mjs`.
 *
 * An engine setting's field is named by the label and the key its row shows,
 * so a screen reader says "Segment length HLS_FRAGMENT" and voice control finds
 * the field by its label, where a name of the key alone offered neither.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { engineFieldLabelledBy, settingFieldId, settingKeyId, settingLabelId } from './settingFieldIds';

describe('the ids of a setting', () => {
  it('names an engine field by its label, then its key, as its row shows them', () => {
    assert.equal(
      engineFieldLabelledBy('HLS_FRAGMENT'),
      'deployment-setting-HLS_FRAGMENT-label deployment-setting-HLS_FRAGMENT-key',
    );
  });

  it('gives the field, its label and its key an id each', () => {
    const ids = [settingFieldId('SRT_LATENCY'), settingLabelId('SRT_LATENCY'), settingKeyId('SRT_LATENCY')];

    assert.deepEqual(ids, [
      'deployment-setting-SRT_LATENCY',
      'deployment-setting-SRT_LATENCY-label',
      'deployment-setting-SRT_LATENCY-key',
    ]);
  });
});
