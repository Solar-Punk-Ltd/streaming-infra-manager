import {
  ABR_RUNG_COMPONENTS,
  BEE_GATEWAY_SERVICE,
  BEE_UPLOADER_SERVICE,
  CLIENT_SERVICE,
  type ConfiguredBeeRpcEndpoint,
  DEFAULT_ABR_RUNGS,
  DEFAULT_RPC_ENDPOINT_SOURCE,
  generateSrtPassphrase,
  isLadderKind,
  LIGHT_NODE_MODE,
  MANAGER_RPC_ENDPOINT_SOURCE,
  type NodeMode,
  OME_SERVICE,
  type RpcEndpointSource,
  SRS_SERVICE,
  type StackVersion,
  STREAM_UPLOADER_SERVICE,
  ULTRA_LIGHT_NODE_MODE,
} from '@streaming-infra-manager/common';
import { generatePrivateKey } from 'viem/accounts';

import type { WizardPrefill } from '../../app/EditorsContext';
import type { NewDeploymentShape } from '../../deployments/settings/deploymentSettingsApi';
import type { NewDeploymentSettingValues } from '../../deployments/settings/newDeploymentSettingsDraft';
import type { NewDeploymentSettingsLoad } from '../../deployments/settings/useNewDeploymentSettings';
import { streamersOf } from '../../deployments/shape';
import type { PoolResults } from '../../groups/useBeePublishers';
import type { DeploymentGroup, Profile } from '../../types';
import { DEFAULT_CUSTOM_COMPONENTS, GOALS } from './wizardGoals';
import { matchingPool } from './poolIdentity';
import { SEGMENT_LENGTH_FIELD } from './segmentLength';

/** What the operator said they want, which decides every field after it. */
export type WizardGoal = NonNullable<WizardPrefill['goal']>;

export type HostChoice = 'this' | 'custom';
export type PassphraseChoice = 'host' | 'generate' | 'custom';
export type KeyChoice = 'generate' | 'paste';
export type StampChoice = 'later' | 'paste';
/**
 * Whether a deployment runs a Bee node of its own or posts to somebody else's.
 *
 * Not how much of a chain that node runs with, which is bee's own word `mode`
 * and lives in `nodeMode`.
 */
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
  beeChoice: BeeChoice;
  beeUrl: string;
  /**
   * How much of a chain this deployment's Bee node runs with, where the step
   * offers the choice. Null everywhere else, including the steps that state
   * the mode rather than asking: see `chosenNodeMode`, which is what to read.
   */
  nodeMode: NodeMode | null;
  rpcEndpointSource: RpcEndpointSource;
  /** The address typed under Custom. Empty under the other two sources. */
  rpcEndpoint: string;
  feedMode: SourceChoice;
  /** Profile name of the stream to follow, when it is one on this manager. */
  feedStreamer: string;
  feedOwner: string;
  poolMode: SourceChoice;
  poolId: number | null;
  poolString: string;
  /** Seconds, as the env file carries it. Empty means send none and take the version's. */
  segmentSeconds: string;
  /**
   * What the operator typed under Advanced settings, by key. A key left out
   * keeps its version's value. The create sends the keys that the list read
   * for the choices on screen takes.
   */
  stackSettings: NewDeploymentSettingValues;
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

/** The step that asks the goal's settings, from which on the version's settings list is read. */
export const SETTINGS_STEP = WIZARD_STEPS.indexOf('Settings') + 1;

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
  /** The chain endpoint this manager offers the nodes it creates, host only. */
  beeRpcEndpoint: ConfiguredBeeRpcEndpoint;
  poolResults: PoolResults;
  /** Every stack version the manager holds, in any state. */
  versions: StackVersion[];
  /**
   * The chosen version's settings list for this deployment, read from the
   * settings step on for the choices on screen. Absent where nothing reads it.
   */
  newDeploymentSettings?: NewDeploymentSettingsLoad;
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
    beeChoice: 'own',
    beeUrl: '',
    nodeMode: null,
    rpcEndpointSource: initialRpcEndpointSource(context),
    rpcEndpoint: '',
    feedMode: prefill?.feedStreamer || streams.length > 0 ? 'pick' : 'paste',
    feedStreamer: prefilledStream,
    feedOwner: '',
    poolMode: prefilledPool != null ? 'pick' : 'paste',
    poolId: prefilledPool,
    poolString: '',
    segmentSeconds: SEGMENT_LENGTH_FIELD.defaultValue,
    stackSettings: {},
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
 * The kind and the services a create body names, which the manager reads the
 * version's settings list for. A node pool's are one rung's, because each
 * rung is created as a Bee node alone. Null services leave them to the kind.
 */
export function createdShapeOf(state: WizardState): Pick<NewDeploymentShape, 'kind' | 'components'> {
  if (state.goal === 'viewer') return { kind: 'viewer', components: null };
  if (state.goal === 'abr-uploader') return { kind: 'abr-uploader', components: null };
  if (state.goal === 'abr-pool') return { kind: 'custom', components: [...ABR_RUNG_COMPONENTS] };
  if (state.goal === 'stream') return { kind: 'streamer', components: chosenComponents(state) };
  return { kind: 'custom', components: state.components };
}

/**
 * The services this deployment would be created with, as the manager reads them.
 *
 * Not `chosenComponents`, which is the Review step's list and says
 * "bee-uploader ×4" for a pool. The shared node rules need the real names, and
 * a pool's rules are its members' rules.
 */
export function nodeServices(state: WizardState): string[] {
  if (state.goal === 'abr-pool') return [BEE_UPLOADER_SERVICE];
  return chosenComponents(state);
}

/**
 * How the settings step asks about this deployment's Bee node.
 *
 * `line` is a node that publishes: it has to have the chain on, so the step
 * states that rather than offering a choice nobody can make. `choice` is a
 * viewer's gateway, the one node that is useful either way. `none` is a
 * deployment that runs no node of its own.
 */
export type NodeModeQuestion = 'none' | 'line' | 'choice';

export function nodeModeQuestion(state: WizardState): NodeModeQuestion {
  const services = nodeServices(state);
  if (services.includes(BEE_UPLOADER_SERVICE)) return 'line';
  return services.includes(BEE_GATEWAY_SERVICE) ? 'choice' : 'none';
}

/**
 * The mode this deployment's node would be created in, or null where it runs
 * none.
 *
 * Read this rather than `state.nodeMode`: ticking an uploader beside a gateway
 * makes the uploader the node, and a mode left behind by the gateway question
 * must not be what is created.
 */
export function chosenNodeMode(state: WizardState): NodeMode | null {
  const question = nodeModeQuestion(state);
  if (question === 'none') return null;
  if (question === 'line') return LIGHT_NODE_MODE;
  return state.nodeMode ?? ULTRA_LIGHT_NODE_MODE;
}

/** A light node reaches a chain, so it is the only one asked where. */
export function offersRpcEndpoint(state: WizardState): boolean {
  return chosenNodeMode(state) === LIGHT_NODE_MODE;
}

/**
 * Which endpoint a new node is offered first: the manager's own whenever there
 * is one, because that is the whole point of configuring one, and the stack's
 * public default only when there is not.
 */
export function initialRpcEndpointSource(context: WizardContext): RpcEndpointSource {
  return context.beeRpcEndpoint.configured
    ? MANAGER_RPC_ENDPOINT_SOURCE
    : DEFAULT_RPC_ENDPOINT_SOURCE;
}

/**
 * A stream pointed at someone else's Bee node, so it runs none of its own.
 *
 * Never in group mode: `POST /groups` takes no `bee_url`, so the choice is not
 * offered there and a value left behind by a visit to step 3 must not change
 * what the group is created with.
 */
export function usesExternalBee(state: WizardState): boolean {
  return state.goal === 'stream' && !state.group && state.beeChoice === 'external';
}

/**
 * A segment length is offered where the deployment runs the engine that reads
 * it, and nowhere else: a stream or a custom deployment that picked SRS, and an
 * ABR uploader, which always runs SRS. A viewer and a node pool run none.
 *
 * `HLS_FRAGMENT` is an SRS key. OME cuts to a duration of its own, which the
 * drawer offers and the wizard does not, so picking OME takes the question away
 * rather than sending a key that engine never reads.
 */
export function offersSegmentLength(state: WizardState): boolean {
  if (state.goal === 'stream') return state.engine === SRS_SERVICE;
  if (state.goal === 'abr-uploader') return true;
  return state.goal === 'custom' && state.components.includes(SRS_SERVICE);
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
