/**
 * The shapes a deployment's page can check before a save, for the stack
 * settings whose accepted values are known.
 *
 * A key with no field is plain text, checked by the container when it starts,
 * as every stack setting was until now. A field that got its bounds wrong would
 * refuse a value the stack takes, so the bounds are the ones the stream
 * uploader's own config reader applies.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STACK_SETTING_FIELDS, stackSettingFieldProblem } from './stackSettingFields.js';

describe('the shape of a stack setting', () => {
  it('takes every start gate mode the uploader knows and nothing else', () => {
    for (const mode of ['chequebook-warn', 'warn', 'refuse']) {
      assert.equal(stackSettingFieldProblem('UPLOADER_START_GATES', mode), null, mode);
    }
    assert.match(stackSettingFieldProblem('UPLOADER_START_GATES', 'off') ?? '', /UPLOADER_START_GATES must be one of chequebook-warn, warn, refuse/);
  });

  it('holds a number to the range the uploader accepts', () => {
    assert.equal(stackSettingFieldProblem('CHEQUEBOOK_MIN_BZZ', '0.25'), null);
    assert.match(stackSettingFieldProblem('CHEQUEBOOK_MIN_BZZ', '-1') ?? '', /at least 0/);
    assert.match(stackSettingFieldProblem('CHEQUEBOOK_MIN_BZZ', '1001') ?? '', /at most 1000/);
    assert.match(stackSettingFieldProblem('CHEQUEBOOK_MIN_BZZ', '0,5') ?? '', /period for decimals/);
  });

  it('holds a whole number to its range, and refuses a fraction', () => {
    assert.equal(stackSettingFieldProblem('CHEQUEBOOK_RECHECK_MS', '60000'), null);
    assert.match(stackSettingFieldProblem('CHEQUEBOOK_RECHECK_MS', '999') ?? '', /at least 1000/);
    assert.match(stackSettingFieldProblem('CHEQUEBOOK_RECHECK_MS', '1.5') ?? '', /whole number/);
  });

  it('takes true and false for a switch', () => {
    assert.equal(stackSettingFieldProblem('STAMP_IMMUTABLE', 'true'), null);
    assert.equal(stackSettingFieldProblem('STAMP_IMMUTABLE', 'false'), null);
    assert.match(stackSettingFieldProblem('STAMP_IMMUTABLE', 'yes') ?? '', /true or false/);
  });

  it('takes an empty value for every field, which leaves the stack its own default', () => {
    for (const key of Object.keys(STACK_SETTING_FIELDS)) {
      assert.equal(stackSettingFieldProblem(key, ''), null, key);
    }
  });

  it('checks nothing about a key it has no field for', () => {
    assert.equal(stackSettingFieldProblem('ADMIN_API_URL', 'anything at all'), null);
  });
});
