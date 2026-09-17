/**
 * What a new deployment starts with before the operator touches anything,
 * tested without a browser.
 *
 * Unit test, no DOM. `pnpm test` in frontend/.
 *
 * The passphrase default is the one that matters here: on a host without a
 * shared passphrase, "use the host-wide passphrase" is unencrypted ingest,
 * and a default is what most deployments keep. The second suite is what the
 * Review step says about the choice, which has to match what the Publish
 * card says once the deployment runs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BEE_GATEWAY_SERVICE,
  BEE_UPLOADER_SERVICE,
  CLIENT_SERVICE,
  type ConfiguredBeeRpcEndpoint,
  CUSTOM_RPC_ENDPOINT_SOURCE,
  LIGHT_NODE_MODE,
  MANAGER_RPC_ENDPOINT_SOURCE,
  STACK_RPC_ENDPOINT_SOURCE,
  ULTRA_LIGHT_NODE_MODE,
} from '@streaming-infra-manager/common';

import {
  chosenNodeMode,
  chosenPassphrase,
  initialWizardState,
  needsPassphrase,
  nodeModeQuestion,
  offersRpcEndpoint,
  passphraseSummary,
  withGoal,
  type WizardContext,
  type WizardState,
} from './wizardState';

const NO_ENDPOINT: ConfiguredBeeRpcEndpoint = { configured: false, host: null };
const OUR_ENDPOINT: ConfiguredBeeRpcEndpoint = {
  configured: true,
  host: 'rpc.internal:8545',
};

function hostWith(
  hostPassphrase: string | null,
  beeRpcEndpoint: ConfiguredBeeRpcEndpoint = NO_ENDPOINT,
): WizardContext {
  return {
    profiles: [],
    groups: [],
    serverHost: 'stream.example',
    hostPassphrase,
    beeRpcEndpoint,
    poolResults: new Map(),
    versions: [],
  };
}

describe('the passphrase a new deployment starts with', () => {
  it('is the host-wide one when the host has one', () => {
    const state = initialWizardState({ goal: 'stream' }, hostWith('shared-by-the-host'));

    assert.equal(state.passMode, 'host');
    assert.equal(chosenPassphrase(state), null, 'null tells the manager to use the host-wide one');
  });

  it('is generated when the host has none, so the default is never unencrypted', () => {
    const state = initialWizardState({ goal: 'stream' }, hostWith(null));

    assert.equal(state.passMode, 'generate');
    assert.equal(chosenPassphrase(state), state.generatedPassphrase);
    // What the submit body sends as srt_passphrase, see sharedBody in wizardSubmit.
    assert.ok(needsPassphrase(state) && chosenPassphrase(state), 'a passphrase of its own is submitted');
  });

  it('is generated for an ABR uploader on such a host as well', () => {
    const state = initialWizardState({ goal: 'abr-uploader' }, hostWith(null));

    assert.ok(needsPassphrase(state) && chosenPassphrase(state) === state.generatedPassphrase);
  });

  it('is recomputed from the host when a change of goal starts the settings over', () => {
    const context = hostWith(null);
    const state = withGoal(initialWizardState({ goal: 'viewer' }, context), 'stream', context);

    assert.equal(state.passMode, 'generate');
  });
});

describe('what the Review step says about the passphrase', () => {
  it('names the host-wide one when the host has one', () => {
    const context = hostWith('shared-by-the-host');

    assert.equal(
      passphraseSummary(initialWizardState({ goal: 'stream' }, context), context),
      'the host-wide passphrase',
    );
  });

  it('says the ingest is unencrypted when the host-wide one is chosen on a host without one', () => {
    // The choice stays offered, as D03 decided, and the Review says what the
    // Publish card will say afterwards, not the name of a passphrase that is
    // not there.
    const context = hostWith(null);
    const state = { ...initialWizardState({ goal: 'stream' }, context), passMode: 'host' as const };

    assert.equal(
      passphraseSummary(state, context),
      'none on this host, so the ingest is unencrypted',
    );
  });

  it('says generated, and your own', () => {
    const context = hostWith(null);
    const generated = initialWizardState({ goal: 'stream' }, context);

    assert.equal(passphraseSummary(generated, context), 'generated for this deployment');
    assert.equal(
      passphraseSummary({ ...generated, passMode: 'custom' }, context),
      'a passphrase of your own',
    );
  });
});

describe('how a new deployment is asked about its Bee node', () => {
  const context = hostWith(null);
  const custom = (components: string[]) => ({
    ...initialWizardState({ goal: 'custom' }, context),
    components,
  });

  it('offers a viewer the choice, starting on the one that costs nothing', () => {
    const viewer = initialWizardState({ goal: 'viewer' }, context);

    assert.equal(nodeModeQuestion(viewer), 'choice');
    assert.equal(chosenNodeMode(viewer), ULTRA_LIGHT_NODE_MODE);
  });

  it('states the mode of a stream own node rather than asking', () => {
    const stream = initialWizardState({ goal: 'stream' }, context);

    assert.equal(nodeModeQuestion(stream), 'line');
    assert.equal(chosenNodeMode(stream), LIGHT_NODE_MODE);
  });

  it('states it for a pool member, which is nothing but a publishing node', () => {
    const pool = initialWizardState({ goal: 'abr-pool' }, context);

    assert.equal(nodeModeQuestion(pool), 'line');
    assert.equal(chosenNodeMode(pool), LIGHT_NODE_MODE);
  });

  it('asks nothing of a deployment that runs no node of its own', () => {
    const uploader = initialWizardState({ goal: 'abr-uploader' }, context);
    const external = {
      ...initialWizardState({ goal: 'stream' }, context),
      beeChoice: 'external' as const,
    };

    assert.equal(nodeModeQuestion(uploader), 'none');
    assert.equal(chosenNodeMode(uploader), null);
    assert.equal(nodeModeQuestion(external), 'none');
    assert.equal(chosenNodeMode(external), null);
  });

  it('follows the components a custom deployment ticked', () => {
    assert.equal(nodeModeQuestion(custom([CLIENT_SERVICE, BEE_GATEWAY_SERVICE])), 'choice');
    assert.equal(nodeModeQuestion(custom([BEE_UPLOADER_SERVICE])), 'line');
    assert.equal(nodeModeQuestion(custom([CLIENT_SERVICE])), 'none');
  });

  /**
   * Ticking an uploader beside a gateway makes the uploader this deployment's
   * node, and that node has to publish. A mode left behind by the gateway
   * question must not be what is created.
   */
  it('takes the publishing node as the answer when both are ticked', () => {
    const both: WizardState = {
      ...custom([BEE_GATEWAY_SERVICE, BEE_UPLOADER_SERVICE]),
      nodeMode: ULTRA_LIGHT_NODE_MODE,
    };

    assert.equal(nodeModeQuestion(both), 'line');
    assert.equal(chosenNodeMode(both), LIGHT_NODE_MODE);
  });
});

describe('where a new node is told to reach the chain', () => {
  it('starts on the manager own endpoint when it has one', () => {
    const state = initialWizardState({ goal: 'stream' }, hostWith(null, OUR_ENDPOINT));

    assert.equal(state.rpcEndpointSource, MANAGER_RPC_ENDPOINT_SOURCE);
    assert.equal(state.rpcEndpoint, '');
  });

  it('starts on the stack default when the manager has none', () => {
    const state = initialWizardState({ goal: 'stream' }, hostWith(null));

    assert.equal(state.rpcEndpointSource, STACK_RPC_ENDPOINT_SOURCE);
  });

  it('keeps the manager endpoint across a change of goal', () => {
    const context = hostWith(null, OUR_ENDPOINT);
    const state = withGoal(initialWizardState({ goal: 'viewer' }, context), 'stream', context);

    assert.equal(state.rpcEndpointSource, MANAGER_RPC_ENDPOINT_SOURCE);
  });

  it('asks a light node and nothing else', () => {
    const context = hostWith(null, OUR_ENDPOINT);
    const viewer = initialWizardState({ goal: 'viewer' }, context);

    assert.equal(offersRpcEndpoint(initialWizardState({ goal: 'stream' }, context)), true);
    assert.equal(offersRpcEndpoint(viewer), false);
    assert.equal(offersRpcEndpoint({ ...viewer, nodeMode: LIGHT_NODE_MODE }), true);
    assert.equal(offersRpcEndpoint(initialWizardState({ goal: 'abr-uploader' }, context)), false);
  });

  it('holds the typed address apart from the two sources that carry none', () => {
    const state: WizardState = {
      ...initialWizardState({ goal: 'stream' }, hostWith(null)),
      rpcEndpointSource: CUSTOM_RPC_ENDPOINT_SOURCE,
      rpcEndpoint: 'http://host.docker.internal:9000',
    };

    assert.equal(state.rpcEndpoint, 'http://host.docker.internal:9000');
    assert.equal(offersRpcEndpoint(state), true);
  });
});
