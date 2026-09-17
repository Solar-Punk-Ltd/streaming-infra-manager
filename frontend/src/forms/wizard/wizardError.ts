import {
  beePublishersProblem,
  beeUrlProblem,
  CUSTOM_RPC_ENDPOINT_SOURCE,
  LADDER_GROUP_NAME_MAX,
  rpcEndpointChoiceProblem,
} from '@streaming-infra-manager/common';

import {
  addressProblem,
  groupSizeProblem,
  hostProblem,
  nameProblem,
  notesProblem,
  passphraseProblem,
  privateKeyProblem,
  stampIdProblem,
} from '../validation';
import { segmentLengthError } from './segmentLength';
import {
  chosenNodeMode,
  chosenVersion,
  isNameTaken,
  LAST_STEP,
  needsExternalBeeUrl,
  needsFeedOwner,
  needsPassphrase,
  needsStamp,
  needsStreamKey,
  nodeServices,
  offersRpcEndpoint,
  offersSegmentLength,
  poolValueIn,
  type WizardContext,
  type WizardState,
} from './wizardState';

const NAME_TAKEN = 'That name is taken';
const NO_VERSION = 'Pick a stack version';
const POOL_NAME_TOO_LONG = `Pool name: at most ${LADDER_GROUP_NAME_MAX} characters, because the members are named <pool>-1080p`;

/**
 * What stops the operator moving on from the step they are on, in one sentence.
 *
 * One function rather than a message per field: the footer shows a single line
 * next to a disabled Continue, so the order here is the order the fields should
 * be fixed in.
 */
export function wizardError(
  state: WizardState,
  context: WizardContext,
): string | null {
  if (state.step === 2) return basicsError(state, context);
  if (state.step === 3) return settingsError(state, context);
  // The review re-checks everything against live data: a pool can stop being
  // ready, or a name can get taken, while the operator reads the summary.
  if (state.step >= LAST_STEP) {
    return basicsError(state, context) ?? settingsError(state, context);
  }
  return null;
}

/**
 * The line beside the footer button, which goes quiet while a create is in
 * flight.
 *
 * The manager publishes a created deployment on the events stream before the
 * request that created it has answered, so the wizard's own list gains the name
 * it is submitting and `wizardError` then reports that name as taken. It is
 * taken, by the deployment being created, which is not something an operator
 * can act on and not something to say while they wait.
 */
export function footerError(
  state: WizardState,
  context: WizardContext,
  submitting: boolean,
): string | null {
  return submitting ? null : wizardError(state, context);
}

/**
 * What is wrong with the name, or null.
 *
 * One answer for the line under the field and for the footer next to the
 * disabled Continue, so the two never disagree about the same name.
 */
export function nameError(
  state: WizardState,
  context: WizardContext,
): string | null {
  const name = nameProblem(state.name);
  if (name) return name;
  if (state.goal === 'abr-pool' && state.name.length > LADDER_GROUP_NAME_MAX) {
    return POOL_NAME_TOO_LONG;
  }
  if (isNameTaken(context, state.name)) return NAME_TAKEN;
  return null;
}

/**
 * What is wrong with a pasted pool string, or null. An empty one is not
 * wrong yet, the footer asks for it.
 */
export function poolStringError(value: string): string | null {
  if (!value.trim()) return null;
  const problem = beePublishersProblem(value);
  return problem ? `Pool string: ${problem}` : null;
}

/**
 * What is wrong with where this deployment's node would reach the chain, or
 * null.
 *
 * The rule is the shared one, asked here with what the create body will carry,
 * so the wizard refuses exactly what the manager would rather than sending a
 * filled-in form to be refused at the API.
 */
export function rpcEndpointError(
  state: WizardState,
  context: WizardContext,
): string | null {
  if (!offersRpcEndpoint(state)) return null;
  const problem = rpcEndpointChoiceProblem({
    source: state.rpcEndpointSource,
    // The address belongs to the custom source and to nothing else, which the
    // shared rule refuses rather than ignores, so a value left behind by a
    // visit to Custom is not offered to it.
    url: state.rpcEndpointSource === CUSTOM_RPC_ENDPOINT_SOURCE ? state.rpcEndpoint : '',
    managerHasEndpoint: context.beeRpcEndpoint.configured,
    nodeMode: chosenNodeMode(state),
    services: nodeServices(state),
  });
  return problem === null ? null : `Chain endpoint: ${problem}`;
}

function basicsError(
  state: WizardState,
  context: WizardContext,
): string | null {
  const name = nameError(state, context);
  if (name) return name;
  if (state.host === 'custom') {
    const host = hostProblem(state.hostCustom);
    if (host) return host;
  }
  if (state.group) {
    const size = groupSizeProblem(state.size);
    if (size) return size;
  }
  // A version can stop being choosable while the dialog is open: an Update
  // puts it back to building, and the select then names nothing.
  if (!chosenVersion(state, context)) {
    return NO_VERSION;
  }
  return notesProblem(state.notes);
}

function settingsError(
  state: WizardState,
  context: WizardContext,
): string | null {
  if (state.goal === 'custom' && state.components.length === 0) {
    return 'Pick at least one component';
  }

  if (needsPassphrase(state) && state.passMode === 'custom') {
    const problem = passphraseProblem(state.ownPassphrase);
    if (problem) return problem;
  }

  if (needsStreamKey(state) && state.keyMode === 'paste') {
    const problem = privateKeyProblem(state.pastedKey);
    if (problem) return problem;
  }

  if (needsFeedOwner(state)) {
    if (state.feedMode === 'pick' && !state.feedStreamer) {
      return 'Pick a stream to follow';
    }
    if (state.feedMode === 'paste') {
      const problem = addressProblem(state.feedOwner);
      if (problem) return problem;
    }
  }

  if (offersSegmentLength(state)) {
    const problem = segmentLengthError(state.segmentSeconds);
    if (problem) return problem;
  }

  if (needsStamp(state) && state.stampMode === 'paste') {
    const problem = stampIdProblem(state.stampId);
    if (problem) return problem;
  }

  if (state.goal === 'stream') {
    if (state.beeChoice === 'external') {
      if (!state.beeUrl.trim()) return 'Enter the Bee API address';
      const problem = beeUrlProblem(state.beeUrl);
      if (problem) return `Bee API: ${problem}`;
    }
  }

  if (needsExternalBeeUrl(state) && state.beeUrl.trim()) {
    const problem = beeUrlProblem(state.beeUrl);
    if (problem) return `Bee API: ${problem}`;
  }

  const endpoint = rpcEndpointError(state, context);
  if (endpoint) return endpoint;

  if (state.goal === 'abr-uploader') return poolError(state, context);

  return null;
}

function poolError(
  state: WizardState,
  context: WizardContext,
): string | null {
  if (state.poolMode === 'pick') {
    if (state.poolId == null) return 'Pick a node pool';
    return poolValueIn(context, state.poolId) === null
      ? 'That pool is not ready yet. Pick another one, or paste a pool string.'
      : null;
  }
  if (!state.poolString.trim()) {
    return 'Paste the pool string, copied from a pool page';
  }
  return poolStringError(state.poolString);
}
