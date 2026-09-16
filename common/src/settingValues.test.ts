/**
 * What a settings value may be, checked by the page and by the manager.
 *
 * The values here are shapes rather than secrets. What the rule protects
 * against is a value the stack's own env loader and the manager's parser read
 * differently: the page would show one thing, the containers would start with
 * another, and nothing would say so.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { envValueProblem, settingValueProblem } from './settingValues.js';

describe('envValueProblem', () => {
  it('takes an ordinary value', () => {
    for (const value of ['', 'abc', '3000', 'a'.repeat(64), 'http://localhost:1633/', 'a#b']) {
      assert.equal(envValueProblem(value), null, value);
    }
  });

  it('refuses a line break, which would become a second assignment', () => {
    assert.match(envValueProblem('3000\nSTAMP=stolen') ?? '', /line break/);
    assert.match(envValueProblem('3000\rSTAMP=stolen') ?? '', /line break/);
  });

  it('refuses a control character the readers disagree about', () => {
    for (const control of ['\u0000', '\u0007', '\u000b', '\u001b', '\u2028', '\u2029']) {
      assert.match(envValueProblem(`ab${control}cd`) ?? '', /control character/, JSON.stringify(control));
    }
  });

  it('refuses padding, which the two readers keep and drop differently', () => {
    assert.match(envValueProblem('  padded  ') ?? '', /space/);
    assert.match(envValueProblem('padded ') ?? '', /space/);
    assert.match(envValueProblem('\tpadded') ?? '', /space/);
  });

  it('refuses an unquoted space before a hash, which the stack reads as a comment', () => {
    assert.match(envValueProblem('abc #notacomment') ?? '', /#/);
    assert.match(envValueProblem('abc\t#notacomment') ?? '', /#/);
  });

  it('refuses a quote that does not close at the end of the value', () => {
    assert.match(envValueProblem('"unclosed') ?? '', /quote/);
    assert.match(envValueProblem("'unclosed") ?? '', /quote/);
    assert.match(envValueProblem('"closed" and more') ?? '', /quote/);
  });

  it('takes a value quoted end to end, which both readers unwrap the same way', () => {
    assert.equal(envValueProblem('"  padded  "'), null);
    assert.equal(envValueProblem('"abc #notacomment"'), null);
    assert.equal(envValueProblem("'abc'"), null);
    assert.equal(envValueProblem('""'), null);
  });

  it('says how to write a value it refuses, without repeating the value', () => {
    const problem = envValueProblem('abc #notacomment') ?? '';

    assert.match(problem, /[Qq]uote/);
    assert.equal(problem.includes('notacomment'), false);
  });
});

describe('settingValueProblem', () => {
  it('applies the env rule to an ordinary key', () => {
    assert.equal(settingValueProblem('API_PORT', '3000'), null);
    assert.match(settingValueProblem('API_PORT', '3000 #x') ?? '', /#/);
  });

  it('takes an absolute path or nothing at all for an engine config file', () => {
    for (const key of ['SRS_CONF_FILE', 'OME_CONF_FILE']) {
      assert.equal(settingValueProblem(key, ''), null, key);
      assert.equal(settingValueProblem(key, '/srv/stack/engines/srs/srs.conf'), null, key);
      assert.equal(settingValueProblem(key, '/srv/stack-1.2_a/conf'), null, key);
    }
  });

  it('refuses anything a shell or a mount would read as more than a path', () => {
    for (const value of ['$(whoami)', 'relative/path', '/srv/a b', '/srv/a;rm', '/srv/$HOME', '/srv/a"b']) {
      assert.match(settingValueProblem('SRS_CONF_FILE', value) ?? '', /absolute path/, value);
    }
  });
});

describe('settingValueProblem on a key that holds a credential', () => {
  const HEX = 'a3'.repeat(32);

  it('refuses the four characters the engine entrypoints refuse', () => {
    // sed expands a bare & to the whole match and / is its delimiter, so a
    // token carrying one is written into the engine config as something else
    // and the engine starts on it. Both entrypoints exit 1 rather than let
    // that happen, and every one of the four reaches here as a plain value.
    assert.match(settingValueProblem('SRS_WEBHOOK_TOKEN', 'aB3/xY9+Kk=') ?? '', /must not contain/);
    assert.match(settingValueProblem('OME_ADMISSION_SECRET', 'ab&cd') ?? '', /must not contain/);
    assert.match(settingValueProblem('API_AUTH_TOKEN', 'ab|cd') ?? '', /must not contain/);
    assert.match(settingValueProblem('PUBLISH_KEY_SECRET', 'ab\\cd') ?? '', /must not contain/);
  });

  it('says how to make one, without repeating the value', () => {
    const problem = settingValueProblem('SRS_WEBHOOK_TOKEN', 'aB3/xY9+Kk=') ?? '';

    assert.match(problem, /openssl rand -hex 32/);
    assert.equal(problem.includes('xY9'), false);
  });

  it('takes a 64 hex value, which is what the manager generates', () => {
    for (const key of ['SRS_WEBHOOK_TOKEN', 'OME_ADMISSION_SECRET', 'SRT_PASSPHRASE']) {
      assert.equal(settingValueProblem(key, HEX), null, key);
    }
  });

  it('holds a version-wide SRT passphrase to the rule a deployment is held to', () => {
    // libsrt refuses a passphrase outside 10 to 79 characters, and the value
    // is spliced into four places that read punctuation differently, so the
    // per-deployment field has taken the unreserved set alone since it existed.
    assert.match(settingValueProblem('SRT_PASSPHRASE', 'abc') ?? '', /10-79 characters/);
    assert.match(settingValueProblem('SRT_PASSPHRASE', 'a'.repeat(80)) ?? '', /10-79 characters/);
    assert.match(settingValueProblem('SRT_PASSPHRASE', 'passphrase!') ?? '', /letters, digits/);
  });

  it('still takes an empty value, which is how a secret is left unset', () => {
    for (const key of ['SRT_PASSPHRASE', 'SRS_WEBHOOK_TOKEN', 'OME_ADMISSION_SECRET']) {
      assert.equal(settingValueProblem(key, ''), null, key);
    }
  });

  it('leaves a key that holds no credential alone', () => {
    assert.equal(settingValueProblem('HLS_FRAGMENT', '1.5'), null);
    assert.equal(settingValueProblem('BEE_URL', 'http://10.0.0.7:1633/'), null);
  });
});
