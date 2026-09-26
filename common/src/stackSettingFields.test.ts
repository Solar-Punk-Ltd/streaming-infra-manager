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

import { ADMIN_API_TOKEN_MIN_LENGTH } from './adminLink.js';
import { STACK_SETTING_FIELDS, stackSettingFieldOf, stackSettingFieldProblem } from './stackSettingFields.js';

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
    assert.equal(stackSettingFieldProblem('VITE_APP_TITLE', 'anything at all'), null);
  });
});

describe('the web2 admin link keys', () => {
  it('takes an http or https address with a host, a port or a path', () => {
    for (const url of ['http://admin:9877', 'https://admin.example.com', 'https://admin.example.com/', 'http://10.0.0.5:9877/admin']) {
      assert.equal(stackSettingFieldProblem('ADMIN_API_URL', url), null, url);
    }
  });

  it('refuses an address that is not http or https, or names no host', () => {
    for (const url of ['admin.example.com', 'ftp://admin.example.com', 'javascript:alert(1)', 'https://', 'not an address']) {
      assert.match(stackSettingFieldProblem('ADMIN_API_URL', url) ?? '', /ADMIN_API_URL must be an http or https address/, url);
    }
  });

  it('refuses a user name or a password in the address, and never repeats the address', () => {
    const problem = stackSettingFieldProblem('ADMIN_API_URL', 'https://operator:synthetic-password@admin.example.com');
    assert.match(problem ?? '', /ADMIN_API_URL cannot carry a user name or a password/);
    assert.doesNotMatch(problem ?? '', /synthetic-password|operator/);
  });

  it('refuses a # part, which the uploader would put its own paths after', () => {
    for (const url of ['https://admin.example.com/#streams', 'https://admin.example.com/#']) {
      assert.match(stackSettingFieldProblem('ADMIN_API_URL', url) ?? '', /ADMIN_API_URL cannot carry a # part/, url);
    }
  });

  it('holds the token to the uploader floor of 32 characters, and never repeats it', () => {
    assert.equal(ADMIN_API_TOKEN_MIN_LENGTH, 32);
    assert.equal(stackSettingFieldProblem('ADMIN_API_TOKEN', 'a'.repeat(32)), null);
    const short = 'synthetic-short-token';
    const problem = stackSettingFieldProblem('ADMIN_API_TOKEN', short);
    assert.equal(problem, 'ADMIN_API_TOKEN must be at least 32 characters.');
    assert.doesNotMatch(problem ?? '', new RegExp(short));
  });

  it('takes an empty address and an empty token, which leave admin mode off', () => {
    assert.equal(stackSettingFieldProblem('ADMIN_API_URL', ''), null);
    assert.equal(stackSettingFieldProblem('ADMIN_API_TOKEN', ''), null);
  });

  it('gives both keys a field, the address its own kind and the token its floor', () => {
    assert.deepEqual(stackSettingFieldOf('ADMIN_API_URL'), { kind: 'url' });
    assert.deepEqual(stackSettingFieldOf('ADMIN_API_TOKEN'), { kind: 'text', minLength: 32 });
  });
});
