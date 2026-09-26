/**
 * The ids a setting's row gives its field and the words that name and describe it.
 *
 * Unit test, no browser. `pnpm test` in frontend/. The name and description a
 * browser works out from them are read in `frontend/test/deployment-settings-browser.test.mjs`.
 *
 * An engine setting's field is named by the label and the key its row shows,
 * so a screen reader says "Segment length HLS_FRAGMENT" and voice control finds
 * the field by its label, where a name of the key alone offered neither. It is
 * described by the line under it and by the default beside it, so the reader
 * also hears what the field takes and what a reset goes back to.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  engineFieldDescribedBy,
  engineFieldLabelledBy,
  settingDefaultId,
  settingFieldId,
  settingHelperTextId,
  settingKeyId,
  settingLabelId,
} from './settingFieldIds';

describe('the ids of a setting', () => {
  it('names an engine field by its label, then its key, as its row shows them', () => {
    assert.equal(
      engineFieldLabelledBy('HLS_FRAGMENT'),
      'deployment-setting-HLS_FRAGMENT-label deployment-setting-HLS_FRAGMENT-key',
    );
  });

  it('describes an engine field by the line under it, then its default, and by its default alone while no line shows', () => {
    assert.equal(
      engineFieldDescribedBy('HLS_FRAGMENT', { helperText: true }),
      'deployment-setting-HLS_FRAGMENT-helper-text deployment-setting-HLS_FRAGMENT-default',
    );
    assert.equal(engineFieldDescribedBy('ABR_PRESET', { helperText: false }), 'deployment-setting-ABR_PRESET-default');
  });

  it('gives the field, its label, its key, the line under it and its default an id each', () => {
    const ids = [
      settingFieldId('SRT_LATENCY'),
      settingLabelId('SRT_LATENCY'),
      settingKeyId('SRT_LATENCY'),
      settingHelperTextId('SRT_LATENCY'),
      settingDefaultId('SRT_LATENCY'),
    ];

    assert.deepEqual(ids, [
      'deployment-setting-SRT_LATENCY',
      'deployment-setting-SRT_LATENCY-label',
      'deployment-setting-SRT_LATENCY-key',
      'deployment-setting-SRT_LATENCY-helper-text',
      'deployment-setting-SRT_LATENCY-default',
    ]);
  });
});
