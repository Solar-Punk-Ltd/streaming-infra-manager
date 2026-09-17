/**
 * What the wizard's create body says about the Bee node it is making: how much
 * of a chain that node runs with, and where it reaches the chain.
 *
 * Unit test, no DOM, the request captured off a mocked fetch the way the
 * segment length submission test does it. `pnpm test` in frontend/.
 *
 * Both are chosen when the node is created and nowhere else (T27, Levi
 * 2026-09-17), so the body is the only door either value has.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BEE_GATEWAY_SERVICE,
  BEE_UPLOADER_SERVICE,
  CLIENT_SERVICE,
  CUSTOM_RPC_ENDPOINT_SOURCE,
  LIGHT_NODE_MODE,
  MANAGER_RPC_ENDPOINT_SOURCE,
  type StackVersion,
  STACK_RPC_ENDPOINT_SOURCE,
  ULTRA_LIGHT_NODE_MODE,
} from '@streaming-infra-manager/common';

import {
  initialWizardState,
  type WizardContext,
  type WizardGoal,
  type WizardState,
} from './wizardState';
import { submitWizard } from './wizardSubmit';

const OUR_ENDPOINT = 'rpc.internal:8545';

const context: WizardContext = {
  profiles: [],
  groups: [],
  serverHost: 'fixture.test',
  hostPassphrase: null,
  beeRpcEndpoint: { configured: true, host: OUR_ENDPOINT },
  poolResults: new Map(),
  versions: [
    { id: 7, status: 'ready', isDefault: true, tested: true } as StackVersion,
  ],
};

interface SentRequest {
  path: string;
  body: Record<string, unknown>;
}

function stateFor(goal: WizardGoal, over: Partial<WizardState> = {}): WizardState {
  return { ...initialWizardState({ goal }, context), name: 'stage', ...over };
}

/** Where the wizard sent its one request, and what it put in it. */
async function sentRequest(
  t: { mock: { method: typeof import('node:test').mock.method } },
  state: WizardState,
): Promise<SentRequest> {
  let sent: SentRequest | null = null;
  t.mock.method(globalThis, 'fetch', async (path: unknown, init: RequestInit) => {
    sent = {
      path: String(path),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    };
    return new Response(JSON.stringify({ name: 'stage' }), { status: 202 });
  });
  // A group and a pool each build their outcome from a whole valid response,
  // which is another test's subject. The request has already gone by the time
  // that is read, so failing to build one is not failing to send.
  await submitWizard(state, context).catch(() => undefined);
  if (!sent) throw new Error('the wizard sent no request');
  return sent;
}

describe('the node mode on the wizard create body', () => {
  it('is what the operator picked for a viewer gateway', async (t) => {
    const { body } = await sentRequest(t, stateFor('viewer'));

    assert.equal(body.node_mode, ULTRA_LIGHT_NODE_MODE);
  });

  it('is light for a viewer gateway put on the chain', async (t) => {
    const { body } = await sentRequest(
      t,
      stateFor('viewer', { nodeMode: LIGHT_NODE_MODE }),
    );

    assert.equal(body.node_mode, LIGHT_NODE_MODE);
  });

  /**
   * A publishing node has no choice to record: it has to have the chain on,
   * the step says so rather than asking, and the stack already starts that
   * node light. Sending nothing leaves the column NULL, which is what every
   * deployment made before this row carries and reads the same way.
   */
  it('is absent where the step offered no choice', async (t) => {
    const stream = await sentRequest(t, stateFor('stream'));
    const pool = await sentRequest(t, stateFor('abr-pool'));

    assert.equal('node_mode' in stream.body, false);
    assert.equal('node_mode' in pool.body, false);
  });

  it('is absent for a deployment that runs no Bee node at all', async (t) => {
    const { body } = await sentRequest(t, stateFor('abr-uploader'));

    assert.equal('node_mode' in body, false);
  });
});

describe('the chain endpoint on the wizard create body', () => {
  it('names the manager own endpoint, which is the offered default', async (t) => {
    const { body } = await sentRequest(t, stateFor('stream'));

    assert.equal(body.rpc_endpoint_source, MANAGER_RPC_ENDPOINT_SOURCE);
    assert.equal('rpc_endpoint' in body, false);
  });

  it('carries the address a custom endpoint was typed into, and nothing else does', async (t) => {
    const typed = await sentRequest(
      t,
      stateFor('stream', {
        rpcEndpointSource: CUSTOM_RPC_ENDPOINT_SOURCE,
        rpcEndpoint: ' http://host.docker.internal:9000 ',
      }),
    );
    const stack = await sentRequest(
      t,
      stateFor('stream', { rpcEndpointSource: STACK_RPC_ENDPOINT_SOURCE }),
    );

    assert.equal(typed.body.rpc_endpoint_source, CUSTOM_RPC_ENDPOINT_SOURCE);
    assert.equal(typed.body.rpc_endpoint, 'http://host.docker.internal:9000');
    assert.equal(stack.body.rpc_endpoint_source, STACK_RPC_ENDPOINT_SOURCE);
    assert.equal('rpc_endpoint' in stack.body, false);
  });

  /**
   * A node with no chain reads no endpoint, so naming the manager's would
   * write a keyed URL into an env file that travels to the viewer's host for a
   * node that never reads it. The manager reads an absent source the same way.
   */
  it('is asked of a viewer gateway only once it is light', async (t) => {
    const ultraLight = await sentRequest(t, stateFor('viewer'));
    const light = await sentRequest(t, stateFor('viewer', { nodeMode: LIGHT_NODE_MODE }));

    assert.equal('rpc_endpoint_source' in ultraLight.body, false);
    assert.equal(light.body.rpc_endpoint_source, MANAGER_RPC_ENDPOINT_SOURCE);
  });

  it('is absent where the deployment runs no node to reach a chain from', async (t) => {
    const uploader = await sentRequest(t, stateFor('abr-uploader'));
    const external = await sentRequest(
      t,
      stateFor('stream', { beeChoice: 'external', beeUrl: 'http://10.0.0.7:1633' }),
    );
    const player = await sentRequest(
      t,
      stateFor('custom', { components: [CLIENT_SERVICE] }),
    );

    for (const { body } of [uploader, external, player]) {
      assert.equal('rpc_endpoint_source' in body, false);
      assert.equal('rpc_endpoint' in body, false);
    }
  });

  it('goes to every member of a pool, which is four publishing nodes', async (t) => {
    const { path, body } = await sentRequest(
      t,
      stateFor('abr-pool', {
        rpcEndpointSource: CUSTOM_RPC_ENDPOINT_SOURCE,
        rpcEndpoint: 'http://host.docker.internal:9000',
      }),
    );

    assert.equal(path, '/groups');
    assert.equal(body.rpc_endpoint_source, CUSTOM_RPC_ENDPOINT_SOURCE);
    assert.equal(body.rpc_endpoint, 'http://host.docker.internal:9000');
  });

  it('goes to every member of a group of streams too', async (t) => {
    const { path, body } = await sentRequest(t, stateFor('stream', { group: true }));

    assert.equal(path, '/groups');
    assert.equal(body.rpc_endpoint_source, MANAGER_RPC_ENDPOINT_SOURCE);
  });

  it('follows the components a custom deployment ticked', async (t) => {
    const gateway = await sentRequest(
      t,
      stateFor('custom', {
        components: [CLIENT_SERVICE, BEE_GATEWAY_SERVICE],
        nodeMode: LIGHT_NODE_MODE,
        feedMode: 'paste',
        feedOwner: `0x${'1'.repeat(40)}`,
      }),
    );
    const uploader = await sentRequest(
      t,
      stateFor('custom', { components: [BEE_UPLOADER_SERVICE] }),
    );

    assert.equal(gateway.body.node_mode, LIGHT_NODE_MODE);
    assert.equal(gateway.body.rpc_endpoint_source, MANAGER_RPC_ENDPOINT_SOURCE);
    assert.equal('node_mode' in uploader.body, false);
    assert.equal(uploader.body.rpc_endpoint_source, MANAGER_RPC_ENDPOINT_SOURCE);
  });
});
