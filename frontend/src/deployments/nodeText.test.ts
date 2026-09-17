/**
 * The lines a node's mode and its chain endpoint turn into.
 *
 * Unit test, no DOM. `pnpm test` in frontend/.
 *
 * One set of words for the deployment page and for the wizard's review, so
 * what an operator reads before creating a node and what they read on its page
 * afterwards cannot say different things about the same choice. The endpoint
 * line is also where a secret could escape: an endpoint URL can carry an API
 * key in its path or its user info, so only the host is ever named.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CUSTOM_RPC_ENDPOINT_SOURCE,
  LIGHT_NODE_MODE,
  MANAGER_RPC_ENDPOINT_SOURCE,
  STACK_RPC_ENDPOINT_SOURCE,
  ULTRA_LIGHT_NODE_MODE,
} from '@streaming-infra-manager/common';

import { nodeModeLabel, rpcEndpointLabel } from './nodeText';

describe('what a node mode is called on a page', () => {
  it('names what each mode has, not the one thing it is usually for', () => {
    assert.equal(nodeModeLabel(LIGHT_NODE_MODE), 'Light, on the chain');
    assert.equal(nodeModeLabel(ULTRA_LIGHT_NODE_MODE), 'Ultra-light, download only');
  });
});

describe('what an RPC endpoint is called on a page', () => {
  const light = (source: Parameters<typeof rpcEndpointLabel>[0]['source'], host: string | null) =>
    rpcEndpointLabel({ mode: LIGHT_NODE_MODE, source, host });

  it('names the manager endpoint with the host it is on', () => {
    assert.equal(
      light(MANAGER_RPC_ENDPOINT_SOURCE, 'rpc.internal:8545'),
      "Manager's endpoint (rpc.internal:8545)",
    );
  });

  it('says the stack default is the public one', () => {
    assert.equal(light(STACK_RPC_ENDPOINT_SOURCE, null), 'Stack default, public');
  });

  it('names a custom endpoint by host and stops there', () => {
    assert.equal(light(CUSTOM_RPC_ENDPOINT_SOURCE, 'rpc.example.org'), 'Custom (rpc.example.org)');
  });

  it('names no host it was given none for, rather than an empty bracket', () => {
    assert.equal(light(MANAGER_RPC_ENDPOINT_SOURCE, null), "Manager's endpoint");
    assert.equal(light(CUSTOM_RPC_ENDPOINT_SOURCE, null), 'Custom');
  });

  /**
   * An ultra-light node has no chain at all, so naming the stack's default
   * there would name the very setting that makes it ultra-light as though it
   * were an endpoint the node reads.
   */
  it('says an ultra-light node reaches no chain, whatever its row carries', () => {
    for (const source of [
      MANAGER_RPC_ENDPOINT_SOURCE,
      STACK_RPC_ENDPOINT_SOURCE,
      CUSTOM_RPC_ENDPOINT_SOURCE,
    ] as const) {
      assert.equal(
        rpcEndpointLabel({ mode: ULTRA_LIGHT_NODE_MODE, source, host: 'rpc.internal:8545' }),
        'None, an ultra-light node reaches no chain',
      );
    }
  });
});
