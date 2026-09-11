import {
  beePublishersProblem,
  beeUrlProblem,
  LADDER_GROUP_NAME_MAX,
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
import {
  chosenVersion,
  isNameTaken,
  LAST_STEP,
  needsExternalBeeUrl,
  needsFeedOwner,
  needsPassphrase,
  needsStamp,
  needsStreamKey,
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

  if (needsStamp(state) && state.stampMode === 'paste') {
    const problem = stampIdProblem(state.stampId);
    if (problem) return problem;
  }

  if (state.goal === 'stream') {
    if (state.beeMode === 'external') {
      if (!state.beeUrl.trim()) return 'Enter the Bee API address';
      const problem = beeUrlProblem(state.beeUrl);
      if (problem) return `Bee API: ${problem}`;
    }
  }

  if (needsExternalBeeUrl(state) && state.beeUrl.trim()) {
    const problem = beeUrlProblem(state.beeUrl);
    if (problem) return `Bee API: ${problem}`;
  }

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
