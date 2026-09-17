/**
 * Taking an endpoint's key out of text the manager did not write.
 *
 * A Bee node prints the endpoint it was started with into its own log, and
 * prints it again when it cannot reach the chain. The manager serves that log
 * to a page and keeps a failed start's last lines as the deployment's error, so
 * an endpoint carrying a key in its path lands on a screen and in the database
 * unless something takes it out on the way.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { redactEndpoints } from './redactEndpoints.js';

const MANAGER = 'https://rpc.example.org/v3/abc123';
const CUSTOM = 'http://10.0.0.7:8545/key-xyz';

describe('redactEndpoints', () => {
  it('leaves the host and takes everything after it', () => {
    const line = `chain: connecting to ${MANAGER}`;

    const out = redactEndpoints(line, [MANAGER]);

    assert.equal(out, 'chain: connecting to <rpc.example.org>');
    assert.doesNotMatch(out, /abc123/);
  });

  it('takes a trailing slash with it', () => {
    assert.equal(
      redactEndpoints(`at ${MANAGER}/ now`, [MANAGER]),
      'at <rpc.example.org> now',
    );
  });

  it('finds it inside a longer token', () => {
    // Bee prints it inside a structured line, with no space either side.
    const out = redactEndpoints(`"endpoint"="${CUSTOM}",ok`, [CUSTOM]);

    assert.equal(out, '"endpoint"="<10.0.0.7:8545>",ok');
  });

  it('takes every occurrence, not the first', () => {
    const out = redactEndpoints(`${MANAGER} then ${MANAGER}`, [MANAGER]);

    assert.equal(out, '<rpc.example.org> then <rpc.example.org>');
  });

  it('leaves an address it was not given alone', () => {
    const line = 'reading https://rpc.gnosischain.com and http://bee:1633';

    assert.equal(redactEndpoints(line, [MANAGER]), line);
  });

  it('is a no-op for an empty set, and for a set of nothings', () => {
    const line = `at ${MANAGER}`;

    assert.equal(redactEndpoints(line, []), line);
    assert.equal(redactEndpoints(line, [null, undefined, '', '   ']), line);
  });

  it('takes the longer of two endpoints that start alike', () => {
    // Replacing the shorter one first would leave the rest of the longer one
    // standing, and the rest is the part carrying the key.
    const out = redactEndpoints(`at ${MANAGER}`, ['https://rpc.example.org', MANAGER]);

    assert.equal(out, 'at <rpc.example.org>');
    assert.doesNotMatch(out, /abc123/);
  });

  it('does not read the mask it writes as a replacement pattern', () => {
    // The same trap the env writer hit: a `$&` in a replacement string means
    // the text that matched. Nothing here builds a mask with one, and the
    // address itself is escaped before it becomes a pattern.
    const out = redactEndpoints('at http://host/a+b?c=1', ['http://host/a+b?c=1']);

    assert.equal(out, 'at <host>');
  });

  it('says only that an address was there when it cannot be read', () => {
    const out = redactEndpoints('at not-a-url/key', ['not-a-url/key']);

    assert.equal(out, 'at <redacted>');
  });
});
