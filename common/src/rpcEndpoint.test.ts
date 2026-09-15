import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rpcEndpointProblem } from './publishUrl.js';

describe('the chain endpoint a deployment may name for itself', () => {
  it('accepts nothing, which is how a deployment says it takes the version default', () => {
    for (const empty of [null, undefined, '', '   ']) {
      assert.equal(rpcEndpointProblem(empty), null);
    }
  });

  it('accepts a proxy on the host and a public endpoint alike', () => {
    assert.equal(rpcEndpointProblem('http://host.docker.internal:9000'), null);
    assert.equal(rpcEndpointProblem('https://rpc.gnosischain.com'), null);
    assert.equal(rpcEndpointProblem('  http://10.0.0.7:8545  '), null);
  });

  it('refuses something that is not an http address', () => {
    assert.match(rpcEndpointProblem('rpc.gnosischain.com') ?? '', /http/);
    assert.match(rpcEndpointProblem('not a url at all') ?? '', /http/);
  });

  it('refuses a deploy target pasted in by mistake', () => {
    assert.match(rpcEndpointProblem('http://solarpunk@157.90.34.105:9000') ?? '', /ssh/i);
  });
});
