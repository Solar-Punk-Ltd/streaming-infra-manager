/**
 * BEE_RPC_ENDPOINT: the chain endpoint this manager offers every Bee node it
 * creates.
 *
 * Unit test, no database. `pnpm test` in manager/.
 *
 * A malformed value stops the manager rather than being dropped, for the reason
 * CHEQUEBOOK_FLOOR_BZZ does: a deployment created against a dropped one falls
 * back to the stack's public RPC, which is the endpoint this setting exists to
 * get off, and nothing anywhere would say it had.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { beeRpcEndpoint } from '../../src/utils/config.js';

describe('the endpoint the manager offers its nodes', () => {
  it('is none when the operator set nothing', () => {
    for (const empty of [undefined, '', '   ']) {
      assert.equal(beeRpcEndpoint(empty), null);
    }
  });

  it('takes an address, trimmed', () => {
    assert.equal(
      beeRpcEndpoint('  https://rpc.example.org/key  '),
      'https://rpc.example.org/key',
    );
    assert.equal(
      beeRpcEndpoint('http://host.docker.internal:8545'),
      'http://host.docker.internal:8545',
    );
  });

  it('stops the manager on a value that is not an address, and names it', () => {
    assert.throws(
      () => beeRpcEndpoint('rpc.example.org'),
      /BEE_RPC_ENDPOINT.*http/s,
    );
  });

  it('stops the manager on a deploy target pasted in by mistake', () => {
    assert.throws(
      () => beeRpcEndpoint('http://deploy@10.0.0.7:8545'),
      /BEE_RPC_ENDPOINT.*ssh/s,
    );
  });

  it('stops the manager on a value docker compose would expand', () => {
    // The env file every deployment gets is a full copy of the base env, so
    // ${STREAM_KEY} in this address resolves to the deployment's own signing
    // key on a remote target, in a URL the node then posts to.
    assert.throws(
      () => beeRpcEndpoint('https://evil.example/${STREAM_KEY}'),
      /BEE_RPC_ENDPOINT/,
    );
  });

  it('stops the manager on a value that would write a second env line', () => {
    // The value becomes an RPC_ENDPOINT line in every .env.<profile> written
    // against it, and that file is read a line at a time.
    assert.throws(
      () => beeRpcEndpoint('http://10.0.0.7:8545\nSRS_CONF_FILE=/etc/passwd'),
      /BEE_RPC_ENDPOINT/,
    );
  });
});
