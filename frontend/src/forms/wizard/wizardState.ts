import {
  BEE_UPLOADER_SERVICE,
  CLIENT_SERVICE,
  DEFAULT_ABR_RUNGS,
  generateSrtPassphrase,
  isLadderKind,
  OME_SERVICE,
  SRS_SERVICE,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';
import { generatePrivateKey } from 'viem/accounts';

import type { WizardPrefill } from '../../app/EditorsContext';
import { streamersOf } from '../../deployments/shape';
import type { PoolResults } from '../../groups/useBeePublishers';
import type { DeploymentGroup, Profile } from '../../types';
import { DEFAULT_CUSTOM_COMPONENTS, GOALS } from './wizardGoals';

/** What the operator said they want, which decides every field after it. */
export type WizardGoal = NonNullable<WizardPrefill['goal']>;

export type HostChoice = 'this' | 'custom';
export type PassphraseChoice = 'host' | 'generate' | 'custom';
export type KeyChoice = 'generate' | 'paste';
export type StampChoice = 'later' | 'paste';
export type BeeChoice = 'own' | 'external';
/** Take it from something on this manager, or paste it from somewhere else. */
export type SourceChoice = 'pick' | 'paste';

export interface WizardState {
  step: number;
  goal: WizardGoal | null;
  name: string;
  host: HostChoice;
  hostCustom: string;
  notes: string;
  group: boolean;
  size: string;
  engine: typeof SRS_SERVICE | typeof OME_SERVICE;
  passMode: PassphraseChoice;
  generatedPassphrase: string;
  ownPassphrase: string;
  keyMode: KeyChoice;
  generatedKey: string;
  pastedKey: string;
  stampMode: StampChoice;
  stampId: string;
  beeMode: BeeChoice;
  beeUrl: string;
  feedMode: SourceChoice;
  /** Profile name of the stream to follow, when it is one on this manager. */
  feedStreamer: string;
  feedOwner: string;
  poolMode: SourceChoice;
  poolId: number | null;
  poolString: string;
  components: string[];
}

export const WIZARD_STEPS = [
  'What to set up',
  'Basics',
  'Settings',
  'Review',
] as const;

export const LAST_STEP = WIZARD_STEPS.length;

/** Every step reads the choices so far and writes back a slice of them. */
export interface WizardStepProps {
  state: WizardState;
  context: WizardContext;
  update: (patch: Partial<WizardState>) => void;
}

/** Everything the wizard reads about what already exists on this manager. */
export interface WizardContext {
  profiles: Profile[];
  groups: DeploymentGroup[];
  serverHost: string;
  hostPassphrase: string | null;
  poolResults: PoolResults;
}

export function streamsIn(context: WizardContext): Profile[] {
  return streamersOf(context.profiles);
}

export function poolsIn(context: WizardContext): DeploymentGroup[] {
  return context.groups.filter((group) => isLadderKind(group.kind));
}

/** The pool string a pool on this manager is currently offering, if any. */
export function poolValueIn(
  context: WizardContext,
  poolId: number | null,
): string | null {
  if (poolId == null) return null;
  return context.poolResults.get(poolId)?.value ?? null;
}

export function isNameTaken(context: WizardContext, name: string): boolean {
  return (
    context.profiles.some((profile) => profile.name === name) ||
    context.groups.some((group) => group.name === name)
  );
}

export function initialWizardState(
  prefill: WizardPrefill | undefined,
  context: WizardContext,
): WizardState {
  const streams = streamsIn(context);
  const pools = poolsIn(context);
  // A ready pool is the better default, but readiness arrives from its own
  // request, so the first pool stands in until it does. Picking an unready one
  // is caught on this step with a sentence saying so.
  const preferredPool =
    pools.find((pool) => poolValueIn(context, pool.id) !== null) ?? pools[0];
  const prefilledPool = prefill?.poolId ?? preferredPool?.id ?? null;
  const prefilledStream = prefill?.feedStreamer ?? streams[0]?.name ?? '';

  return {
    // A prefilled goal comes from a button that already answered step 1.
    step: prefill?.goal ? 2 : 1,
    goal: prefill?.goal ?? null,
    name: prefill?.name ?? '',
    host: 'this',
    hostCustom: '',
    notes: '',
    group: false,
    size: '2',
    engine: SRS_SERVICE,
    passMode: 'host',
    generatedPassphrase: generateSrtPassphrase(),
    ownPassphrase: '',
    keyMode: 'generate',
    generatedKey: generatePrivateKey(),
    pastedKey: '',
    stampMode: 'later',
    stampId: '',
    beeMode: 'own',
    beeUrl: '',
    feedMode: prefill?.feedStreamer || streams.length > 0 ? 'pick' : 'paste',
    feedStreamer: prefilledStream,
    feedOwner: '',
    poolMode: prefilledPool != null ? 'pick' : 'paste',
    poolId: prefilledPool,
    poolString: '',
    components: DEFAULT_CUSTOM_COMPONENTS,
  };
}

/**
 * Switching goals starts the settings over. The basics stay, because a name,
 * a host and a note mean the same for every goal, but an answer left behind by
 * the abandoned goal (an external Bee URL, a pasted stamp) must not resurface
 * under a field of the new goal that happens to share its name.
 */
export function withGoal(
  state: WizardState,
  goal: WizardGoal,
  context: WizardContext,
): WizardState {
  if (state.goal === goal) return state;
  return {
    ...initialWizardState({ goal }, context),
    step: state.step,
    name: state.name,
    host: state.host,
    hostCustom: state.hostCustom,
    notes: state.notes,
    group: allowsGroup(goal) ? state.group : false,
    size: state.size,
  };
}

/** The passphrase this deployment would get, or null for the host-wide one. */
export function chosenPassphrase(state: WizardState): string | null {
  if (state.passMode === 'host') return null;
  return state.passMode === 'generate'
    ? state.generatedPassphrase
    : state.ownPassphrase.trim();
}

export function chosenKey(state: WizardState): string {
  return state.keyMode === 'generate'
    ? state.generatedKey
    : state.pastedKey.trim();
}

export function chosenHost(state: WizardState): string {
  return state.host === 'this' ? 'localhost' : state.hostCustom.trim();
}

/**
 * The host as the rest of the screen names it.
 *
 * `localhost` is what gets stored for this machine, and every page renders that
 * as the manager's own hostname, so the review has to as well or it is the only
 * place calling the same box something different.
 */
export function hostLabel(state: WizardState, context: WizardContext): string {
  return state.host === 'this' ? context.serverHost : state.hostCustom.trim();
}

/** The services this deployment would run, for the review list. */
export function chosenComponents(state: WizardState): string[] {
  if (state.goal === 'custom') return state.components;
  if (state.goal === 'abr-pool') return [`${BEE_UPLOADER_SERVICE} ×4`];
  const goal = GOALS.find((entry) => entry.id === state.goal);
  return (goal?.services ?? []).flatMap((service) => {
    if (service === SRS_SERVICE && state.engine === OME_SERVICE) {
      return [OME_SERVICE];
    }
    if (service === BEE_UPLOADER_SERVICE && usesExternalBee(state)) {
      return [];
    }
    return [service];
  });
}

/**
 * A stream pointed at someone else's Bee node, so it runs none of its own.
 *
 * Never in group mode: `POST /groups` takes no `bee_url`, so the choice is not
 * offered there and a value left behind by a visit to step 3 must not change
 * what the group is created with.
 */
export function usesExternalBee(state: WizardState): boolean {
  return state.goal === 'stream' && !state.group && state.beeMode === 'external';
}

export function needsPassphrase(state: WizardState): boolean {
  if (state.goal === 'stream') return state.engine === SRS_SERVICE;
  if (state.goal === 'abr-uploader') return true;
  return state.goal === 'custom' && state.components.includes(SRS_SERVICE);
}

export function needsStreamKey(state: WizardState): boolean {
  if (state.goal === 'stream' || state.goal === 'abr-uploader') return true;
  return (
    state.goal === 'custom' &&
    state.components.includes(STREAM_UPLOADER_SERVICE)
  );
}

/** A stream-uploader pays with postage, so it is asked where that comes from. */
export function needsStamp(state: WizardState): boolean {
  if (state.goal === 'stream') return true;
  return (
    state.goal === 'custom' &&
    state.components.includes(STREAM_UPLOADER_SERVICE)
  );
}

export function needsFeedOwner(state: WizardState): boolean {
  if (state.goal === 'viewer') return true;
  return state.goal === 'custom' && state.components.includes(CLIENT_SERVICE);
}

/** A custom deployment that uploads without a node of its own needs a URL. */
export function needsExternalBeeUrl(state: WizardState): boolean {
  return (
    state.goal === 'custom' &&
    state.components.includes(STREAM_UPLOADER_SERVICE) &&
    !state.components.includes(BEE_UPLOADER_SERVICE)
  );
}

/** Group mode is offered for the goals whose members are interchangeable. */
export function allowsGroup(goal: WizardGoal | null): boolean {
  return goal === 'stream' || goal === 'viewer' || goal === 'custom';
}

export function namePreview(state: WizardState): string {
  if (!state.name) {
    if (state.goal === 'abr-pool') {
      return `Members will be named <pool>-${DEFAULT_ABR_RUNGS.join(', <pool>-')}`;
    }
    if (state.group) {
      return 'Members will be named <group>-profile-1, <group>-profile-2, …';
    }
    return 'Lowercase letters, digits and dashes';
  }
  if (state.goal === 'abr-pool') {
    return `Creates ${DEFAULT_ABR_RUNGS.map((rung) => `${state.name}-${rung}`).join(', ')}`;
  }
  if (state.group) {
    return `Creates ${state.name}-profile-1 … ${state.name}-profile-${state.size}`;
  }
  return 'Looks good';
}

export function deployLabel(state: WizardState): string {
  if (state.goal === 'abr-pool') return 'Create pool (4 nodes)';
  return state.group ? `Deploy group (${state.size})` : 'Deploy';
}
