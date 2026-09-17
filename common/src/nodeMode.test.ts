/**
 * Which mode a deployment's Bee node runs in, and when that choice is wrong.
 *
 * A light node has the chain on: a chequebook, gas and stamps, so it can
 * publish. An ultra-light node has no chain at all and can only retrieve. The
 * stack hard-codes one per service today, so a profile that names none has to
 * read exactly as it behaves now, and a bee-uploader asked to run ultra-light
 * has to be refused where the operator can still fix it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  effectiveNodeMode,
  isLightGateway,
  nodeModeProblem,
  shippedNodeMode,
} from './nodeMode.js';

const STREAMER = { kind: 'streamer' };
const VIEWER = { kind: 'viewer' };
const POOL_MEMBER = { kind: 'custom', components: ['bee-uploader'] };

describe('effectiveNodeMode', () => {
  it('reads a profile that names no mode as the stack ships that node', () => {
    assert.equal(effectiveNodeMode(STREAMER), 'light');
    assert.equal(effectiveNodeMode(POOL_MEMBER), 'light');
    assert.equal(effectiveNodeMode(VIEWER), 'ultra-light');
    assert.equal(effectiveNodeMode({ ...VIEWER, node_mode: null }), 'ultra-light');
  });

  it('takes the mode the profile names over the shipped one', () => {
    assert.equal(effectiveNodeMode({ ...VIEWER, node_mode: 'light' }), 'light');
    assert.equal(
      effectiveNodeMode({ ...POOL_MEMBER, node_mode: 'ultra-light' }),
      'ultra-light',
    );
  });

  it('answers the shipped mode per service list', () => {
    assert.equal(shippedNodeMode(['srs', 'stream-uploader', 'bee-uploader']), 'light');
    assert.equal(shippedNodeMode(['client', 'bee-gateway']), 'ultra-light');
  });
});

describe('nodeModeProblem', () => {
  it('accepts every profile that runs its node the way the stack ships it', () => {
    assert.equal(nodeModeProblem(STREAMER), null);
    assert.equal(nodeModeProblem(POOL_MEMBER), null);
    assert.equal(nodeModeProblem(VIEWER), null);
  });

  it('accepts a gateway an operator puts on the chain', () => {
    assert.equal(nodeModeProblem({ ...VIEWER, node_mode: 'light' }), null);
  });

  it('refuses a bee-uploader asked to run with no chain', () => {
    // An ultra-light node has no chequebook, so it cannot pay for a stamp and
    // cannot upload. The uploader would start and land nothing.
    assert.equal(
      nodeModeProblem({ ...STREAMER, node_mode: 'ultra-light' }),
      'an ultra-light node cannot upload',
    );
    assert.equal(
      nodeModeProblem({ ...POOL_MEMBER, node_mode: 'ultra-light' }),
      'an ultra-light node cannot upload',
    );
  });

  it('says nothing about a deployment that runs no Bee node of its own', () => {
    assert.equal(
      nodeModeProblem({ kind: 'abr-uploader', node_mode: 'ultra-light' }),
      null,
    );
  });
});

describe('isLightGateway', () => {
  it('is the viewer gateway an operator put on the chain', () => {
    assert.equal(isLightGateway(['client', 'bee-gateway'], 'light'), true);
  });

  it('is not the gateway the stack ships', () => {
    assert.equal(isLightGateway(['client', 'bee-gateway'], 'ultra-light'), false);
  });

  it('is not a publisher, whose node is a bee-uploader', () => {
    assert.equal(isLightGateway(['srs', 'stream-uploader', 'bee-uploader'], 'light'), false);
    // A deployment carrying both reads its endpoint through the uploader's own
    // RPC_ENDPOINT, so the gateway keys would say the same thing twice.
    assert.equal(isLightGateway(['bee-gateway', 'bee-uploader'], 'light'), false);
  });
});
