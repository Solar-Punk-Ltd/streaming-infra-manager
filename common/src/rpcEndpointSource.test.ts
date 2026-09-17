/**
 * Where a node's chain endpoint comes from: the manager's own, the stack's
 * default, or one typed in.
 *
 * One rule for the request schema and the wizard alike, because the wizard has
 * to refuse the same choices the API does, and an operator finding out at the
 * API has already filled in a form.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  configuredBeeRpcEndpoint,
  impliedRpcEndpointSource,
  keptRpcEndpointSource,
  rpcEndpointChoiceProblem,
} from './rpcEndpointSource.js';

const PUBLISHER = ['srs', 'stream-uploader', 'bee-uploader'];
const GATEWAY = ['client', 'bee-gateway'];
const ENDPOINT = 'https://rpc.example.org';

describe('rpcEndpointChoiceProblem', () => {
  it('accepts the manager’s own endpoint when the manager has one', () => {
    assert.equal(
      rpcEndpointChoiceProblem({
        source: 'manager',
        managerHasEndpoint: true,
        services: PUBLISHER,
      }),
      null,
    );
  });

  it('refuses the manager’s own endpoint when the manager has none', () => {
    assert.equal(
      rpcEndpointChoiceProblem({
        source: 'manager',
        managerHasEndpoint: false,
        services: PUBLISHER,
      }),
      'the manager has no RPC endpoint configured, choose the stack’s default or type one',
    );
  });

  it('accepts the stack’s default for a publisher and for the gateway it ships', () => {
    assert.equal(
      rpcEndpointChoiceProblem({
        source: 'stack',
        managerHasEndpoint: true,
        services: PUBLISHER,
      }),
      null,
    );
    assert.equal(
      rpcEndpointChoiceProblem({
        source: 'stack',
        managerHasEndpoint: true,
        services: GATEWAY,
      }),
      null,
    );
  });

  it('refuses the stack’s default for a gateway put on the chain', () => {
    // The stack's default for a gateway is no endpoint at all, which is what
    // makes it ultra-light. A light one asking for that default would start
    // with no chain and quietly not be light.
    assert.equal(
      rpcEndpointChoiceProblem({
        source: 'stack',
        managerHasEndpoint: true,
        nodeMode: 'light',
        services: GATEWAY,
      }),
      'a light gateway needs an endpoint: the manager’s or a custom one',
    );
  });

  it('lets a light gateway take the manager’s endpoint or one typed in', () => {
    assert.equal(
      rpcEndpointChoiceProblem({
        source: 'manager',
        managerHasEndpoint: true,
        nodeMode: 'light',
        services: GATEWAY,
      }),
      null,
    );
    assert.equal(
      rpcEndpointChoiceProblem({
        source: 'custom',
        url: ENDPOINT,
        managerHasEndpoint: false,
        nodeMode: 'light',
        services: GATEWAY,
      }),
      null,
    );
  });

  it('needs an address for a custom endpoint and nothing else', () => {
    for (const blank of [undefined, null, '', '   ']) {
      assert.equal(
        rpcEndpointChoiceProblem({
          source: 'custom',
          url: blank,
          managerHasEndpoint: true,
          services: PUBLISHER,
        }),
        'a custom RPC endpoint needs an address',
      );
    }
  });

  it('holds a custom address to the rule every stored address answers to', () => {
    assert.match(
      rpcEndpointChoiceProblem({
        source: 'custom',
        url: 'rpc.example.org',
        managerHasEndpoint: true,
        services: PUBLISHER,
      }) ?? '',
      /http/,
    );
  });

  it('refuses an address beside a source that does not carry one', () => {
    // The column pairs the two: `custom` and a stored address go together and
    // only together, so a value here would be a raw database error later.
    for (const source of ['manager', 'stack'] as const) {
      assert.equal(
        rpcEndpointChoiceProblem({
          source,
          url: ENDPOINT,
          managerHasEndpoint: true,
          services: PUBLISHER,
        }),
        'only a custom RPC endpoint carries an address of its own',
      );
    }
  });
});

describe('the source a body means when it names none', () => {
  const implied = (over: Record<string, unknown> = {}) =>
    impliedRpcEndpointSource({
      managerHasEndpoint: true,
      services: PUBLISHER,
      ...over,
    });

  it('offers the manager’s endpoint on a create when the manager has one', () => {
    assert.equal(implied(), 'manager');
    assert.equal(implied({ managerHasEndpoint: false }), 'stack');
  });

  it('reads an address with no source as a custom one, on a create', () => {
    // What POST /profiles took before a source existed, and what the migration
    // reads such a stored row as.
    assert.equal(implied({ url: ENDPOINT }), 'custom');
  });

  it('gives a node with no chain the stack’s, whatever the manager has', () => {
    // An ultra-light node reads no endpoint at all. Storing the manager's
    // would write a keyed URL into an env file that travels to the viewer's
    // host for a node that never reads it, say on the page that it takes the
    // manager's endpoint, and refuse its redeploy the day the manager loses
    // one it never needed.
    assert.equal(implied({ services: GATEWAY }), 'stack');
    assert.equal(implied({ services: PUBLISHER, nodeMode: 'ultra-light' }), 'stack');
  });

  it('gives a gateway an operator put on the chain the manager’s', () => {
    assert.equal(implied({ services: GATEWAY, nodeMode: 'light' }), 'manager');
  });

  it('keeps a stored choice through an update that says nothing', () => {
    // A saved note must not move a deployment off the manager's endpoint onto
    // the stack's public one.
    assert.equal(keptRpcEndpointSource(null, 'manager'), 'manager');
    assert.equal(keptRpcEndpointSource(null, 'stack'), 'stack');
  });

  it('lets the address and the custom choice travel together', () => {
    assert.equal(keptRpcEndpointSource(ENDPOINT, 'manager'), 'custom');
    assert.equal(keptRpcEndpointSource(null, 'custom'), 'stack');
    assert.equal(keptRpcEndpointSource('   ', 'custom'), 'stack');
  });
});

describe('configuredBeeRpcEndpoint', () => {
  it('says the manager has none when it has none', () => {
    assert.deepEqual(configuredBeeRpcEndpoint(null), {
      configured: false,
      host: null,
    });
    assert.deepEqual(configuredBeeRpcEndpoint('   '), {
      configured: false,
      host: null,
    });
  });

  it('answers the host and nothing after it', () => {
    // An endpoint may carry a key in its path or its userinfo, and this answer
    // goes to every signed-in browser.
    assert.deepEqual(
      configuredBeeRpcEndpoint('https://rpc.example.org:8545/v1/secret-key'),
      { configured: true, host: 'rpc.example.org:8545' },
    );
    assert.deepEqual(
      configuredBeeRpcEndpoint('https://user:pass@rpc.example.org/key'),
      { configured: true, host: 'rpc.example.org' },
    );
  });

  it('says it is configured even when the address will not parse', () => {
    // Startup refuses a malformed endpoint, so this is the shape nothing can
    // reach. It still must not answer a host it could not read.
    assert.deepEqual(configuredBeeRpcEndpoint('not a url'), {
      configured: true,
      host: null,
    });
  });
});
