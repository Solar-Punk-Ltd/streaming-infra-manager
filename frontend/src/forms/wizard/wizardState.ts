import {
  BEE_UPLOADER_SERVICE,
  CLIENT_SERVICE,
  DEFAULT_ABR_RUNGS,
  generateSrtPassphrase,
  isLadderKind,
  OME_SERVICE,
  SRS_SERVICE,
  type StackVersion,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';
import { generatePrivateKey } from 'viem/accounts';

import type { WizardPrefill } from '../../app/EditorsContext';
import { streamersOf } from '../../deployments/shape';
import type { PoolResults } from '../../groups/useBeePublishers';
import type { DeploymentGroup, Profile } from '../../types';
import { DEFAULT_CUSTOM_COMPONENTS, GOALS } from './wizardGoals';
import { matchingPool } from './poolIdentity';

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
  /** The stack version to deploy on. Null until a default or an explicit choice supplies it. */
  versionId: number | null;
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
  onCreatePool?: () => void;
}

/** Everything the wizard reads about what already exists on this manager. */
export interface WizardContext {
  profiles: Profile[];
  groups: DeploymentGroup[];
  serverHost: string;
  hostPassphrase: string | null;
  poolResults: PoolResults;
  /** Every stack version the manager holds, in any state. */
  versions: StackVersion[];
}

/** The versions a deployment can be made on: the ones that finished building. */
export function choosableVersions(context: WizardContext): StackVersion[] {
  return context.versions.filter((version) => version.status === 'ready');
}

/**
 * A sole tested default needs no choice. Other cases need either an explicit
 * selection or a visible explanation of the default's approval state.
 */
export function versionChoiceShown(context: WizardContext): boolean {
  const versions = choosableVersions(context);
  return versions.length !== 1 || !versions[0]?.isDefault || !versions[0]?.tested;
}

export function chosenVersion(
  state: WizardState,
  context: WizardContext,
): StackVersion | null {
  return (
    choosableVersions(context).find((version) => version.id === state.versionId) ??
    null
  );
}

/** What Set as default on the Versions page decides: the preselected version. */
function defaultVersionIn(context: WizardContext): number | null {
  const choosable = choosableVersions(context);
  return (
    choosable.find((version) => version.isDefault)?.id ?? null
  );
}

/**
 * The preselected default, adopted once the list that names it has arrived.
 *
 * `initialWizardState` reads the default when the wizard opens, and on a slow
 * load that is before the versions are there. Without this the required field
 * stays empty for as long as the wizard is open, and Continue never enables,
 * though a default exists and a wizard opened a moment later would have it.
 */
export function withDefaultVersion(
  state: WizardState,
  context: WizardContext,
): WizardState {
  if (state.versionId !== null) return state;
  const preselected = defaultVersionIn(context);
  return preselected === null ? state : { ...state, versionId: preselected };
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
  const group = context.groups.find(group => group.id === poolId);
  if (!group || !matchingPool({ group, profiles: context.profiles.filter(profile => profile.group_id === poolId) }, group.name)) return null;
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
    passMode: defaultPassphraseChoice(context),
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
    versionId: defaultVersionIn(context),
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
    versionId: state.versionId,
  };
}

/**
 * The host-wide passphrase when the host has one, one generated for the
 * deployment when it has none. 'host' on a host without a passphrase is
 * unencrypted ingest, which a default must never be.
 */
export function defaultPassphraseChoice(context: WizardContext): PassphraseChoice {
  return context.hostPassphrase ? 'host' : 'generate';
}

/** The passphrase this deployment would get, or null for the host-wide one. */
export function chosenPassphrase(state: WizardState): string | null {
  if (state.passMode === 'host') return null;
  return state.passMode === 'generate'
    ? state.generatedPassphrase
    : state.ownPassphrase.trim();
}

/**
 * The Review line for the passphrase, in the words the Publish card will use
 * once the deployment runs.
 */
export function passphraseSummary(state: WizardState, context: WizardContext): string {
  if (state.passMode === 'generate') return 'generated for this deployment';
  if (state.passMode === 'custom') return 'a passphrase of your own';
  return context.hostPassphrase
    ? 'the host-wide passphrase'
    : 'none on this host, so the ingest is unencrypted';
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
