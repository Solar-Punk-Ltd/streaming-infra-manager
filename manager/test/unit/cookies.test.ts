/**
 * Reading the Cookie header, which is where the session token arrives.
 *
 * Unit test, no server. Written by hand rather than with a library, so the
 * edges a library would have handled are pinned here: no separating space,
 * an `=` inside the value, quoting, junk pairs, and a name that would be a
 * booby trap as an object key.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCookies } from '../../src/utils/cookies.js';

describe('parseCookies', () => {
  it('reads a single pair', () => {
    assert.equal(parseCookies('sim_session=abc').get('sim_session'), 'abc');
  });

  it('reads pairs with or without a space after the separator', () => {
    for (const header of ['a=1; b=2', 'a=1;b=2', 'a=1 ;  b=2']) {
      const cookies = parseCookies(header);
      assert.equal(cookies.get('a'), '1', header);
      assert.equal(cookies.get('b'), '2', header);
    }
  });

  it('keeps everything after the first = as the value', () => {
    // base64 padding and base64url both put = and - inside a value.
    assert.equal(parseCookies('t=YWJj==').get('t'), 'YWJj==');
    assert.equal(parseCookies('t=a=b=c').get('t'), 'a=b=c');
  });

  it('unwraps a quoted value', () => {
    assert.equal(parseCookies('t="abc"').get('t'), 'abc');
    assert.equal(parseCookies('t="ab"c"').get('t'), 'ab"c');
  });

  it('decodes percent-encoding, and leaves a broken one alone', () => {
    assert.equal(parseCookies('t=a%20b').get('t'), 'a b');
    assert.equal(parseCookies('t=100%').get('t'), '100%');
    assert.equal(parseCookies('t=%E0%A4%A').get('t'), '%E0%A4%A');
  });

  it('is empty for nothing, and skips pairs that are not pairs', () => {
    for (const header of [undefined, '', '   ', ';;', 'novalue', '=orphan']) {
      assert.equal(
        parseCookies(header).size,
        0,
        `should read nothing from ${JSON.stringify(header)}`,
      );
    }
  });

  it('keeps the good pairs when one is junk', () => {
    const cookies = parseCookies('broken; sim_session=abc; =x; b=2');

    assert.equal(cookies.size, 2);
    assert.equal(cookies.get('sim_session'), 'abc');
    assert.equal(cookies.get('b'), '2');
  });

  it('treats an empty value as an empty value', () => {
    assert.equal(parseCookies('sim_session=').get('sim_session'), '');
  });

  it('holds a name that would be a booby trap as an object key', () => {
    // A Map, not an object, so `__proto__` is a key like any other and cannot
    // reach anything's prototype.
    const cookies = parseCookies('__proto__=polluted; sim_session=abc');

    assert.equal(cookies.get('__proto__'), 'polluted');
    assert.equal(cookies.get('sim_session'), 'abc');
  });

  it('lets the last value of a repeated name win', () => {
    assert.equal(parseCookies('t=first; t=second').get('t'), 'second');
  });
});
