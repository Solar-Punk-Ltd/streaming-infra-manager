import {
  ABR_LADDER_SIZE,
  CUSTOM_RPC_ENDPOINT_SOURCE,
} from '@streaming-infra-manager/common';

import { routes } from '../../app/router';
import {
  createDeploymentGroup,
  createProfile,
  type CreateGroupBody,
} from '../../data';
import type { CreateProfileBody, Profile } from '../../types';
import { addressForKey } from '../validation';
import { matchingPool, type CreatedPool } from './poolIdentity';
import { PoolResponseError } from './PoolResponseError';
import { segmentLengthSettings } from './segmentLength';
import {
  chosenComponents,
  chosenHost,
  chosenKey,
  chosenNodeMode,
  chosenPassphrase,
  chosenVersion,
  needsExternalBeeUrl,
  needsFeedOwner,
  needsPassphrase,
  needsStreamKey,
  nodeModeQuestion,
  offersSegmentLength,
  poolValueIn,
  usesExternalBee,
  type WizardContext,
  type WizardState,
} from './wizardState';

/** What the dialog does once the manager has accepted the deployment. */
export interface WizardOutcome {
  profiles: Profile[];
  createdPool?: CreatedPool;
  /** Hash route of the thing that was just created. */
  route: string;
  toast: string;
}

export async function submitWizard(
  state: WizardState,
  context: WizardContext,
  signal?: AbortSignal,
): Promise<WizardOutcome> {
  if (!chosenVersion(state, context)) throw new Error('Pick a stack version');
  const toast = `Deploying ${state.name}…`;

  if (state.goal === 'abr-pool') {
    const result = await createDeploymentGroup({
      group_name: state.name,
      size: ABR_LADDER_SIZE,
      abr_ladder: true,
      kind: 'custom',
      host: chosenHost(state),
      notes: notesOf(state),
      stack_version_id: versionOf(state),
      // A pool is four publishing nodes, and they all reach the chain the same
      // way. The rest of this body is the pool's own shape rather than a
      // profile's, so the node choices are added here as well.
      ...nodeBody(state),
    }, signal);
    const createdPool = matchingPool(result, state.name);
    if (!createdPool) throw new PoolResponseError();
    return { profiles: createdPool.profiles, route: routes.group(createdPool.group.id), toast, createdPool };
  }

  if (state.group) {
    const result = await createDeploymentGroup({
      ...groupBody(state, context),
      group_name: state.name,
      size: Number(state.size),
      host: chosenHost(state),
    }, signal);
    return { profiles: result.profiles, route: routes.group(result.group.id), toast };
  }

  const profile = await createProfile({
    ...profileBody(state, context),
    name: state.name,
    host: chosenHost(state),
  }, signal);
  return { profiles: [profile], route: routes.deployment(profile.name), toast };
}

function notesOf(state: WizardState): string | null {
  return state.notes.trim() || null;
}

function versionOf(state: WizardState): number {
  if (state.versionId === null) throw new Error('Pick a stack version');
  return state.versionId;
}

/** The address of the feed a viewer or a client follows. */
function feedOwnerOf(
  state: WizardState,
  context: WizardContext,
): string | undefined {
  if (!needsFeedOwner(state)) return undefined;
  if (state.feedMode === 'paste') return state.feedOwner.trim() || undefined;
  const streamer = context.profiles.find(
    (profile) => profile.name === state.feedStreamer,
  );
  return streamer?.public_key ?? undefined;
}

/** The fields every kind shares, so the single and group bodies cannot drift. */
function sharedBody(state: WizardState, context: WizardContext) {
  const key = needsStreamKey(state) ? chosenKey(state) : '';
  // Both are gated on the components that read them, so a choice made for one
  // goal and then abandoned for another is not stored where nothing uses it.
  const passphrase = needsPassphrase(state) ? chosenPassphrase(state) : null;
  return {
    notes: notesOf(state),
    feed_owner: feedOwnerOf(state, context),
    private_key: key || undefined,
    public_key: (key && addressForKey(key)) || undefined,
    srt_passphrase: passphrase ?? undefined,
    stack_version_id: versionOf(state),
    engine_settings: offersSegmentLength(state)
      ? segmentLengthSettings(state.segmentSeconds)
      : undefined,
  };
}

/**
 * What this deployment says about the Bee node it is creating: the mode where
 * the step offered a choice, and where it reaches the chain.
 *
 * The source is always named. A body that leaves it out is read by
 * `impliedRpcEndpointSource`, which lands on the same answer, so saying it
 * plainly costs nothing and leaves nothing for the two sides to disagree
 * about later. The mode is left out where the step offered no choice: a
 * publishing node is told it is light rather than asked, and the stack already
 * starts that node with the chain on, so a stored null reads the same way.
 */
function nodeBody(state: WizardState): Partial<CreateProfileBody> {
  const address =
    state.rpcEndpointSource === CUSTOM_RPC_ENDPOINT_SOURCE
      ? state.rpcEndpoint.trim()
      : '';
  return {
    ...(nodeModeQuestion(state) === 'choice'
      ? { node_mode: chosenNodeMode(state) }
      : {}),
    rpc_endpoint_source: state.rpcEndpointSource,
    ...(address ? { rpc_endpoint: address } : {}),
  };
}

function profileBody(
  state: WizardState,
  context: WizardContext,
): Omit<CreateProfileBody, 'name' | 'host'> {
  return { ...kindBody(state, context), ...nodeBody(state) };
}

function kindBody(
  state: WizardState,
  context: WizardContext,
): Omit<CreateProfileBody, 'name' | 'host'> {
  const shared = sharedBody(state, context);

  if (state.goal === 'viewer') {
    return {
      kind: 'viewer',
      notes: shared.notes,
      feed_owner: shared.feed_owner,
      stack_version_id: shared.stack_version_id,
    };
  }

  if (state.goal === 'abr-uploader') {
    return {
      ...shared,
      kind: 'abr-uploader',
      bee_publishers: poolStringOf(state, context),
    };
  }

  if (state.goal === 'stream') {
    return {
      ...shared,
      kind: 'streamer',
      components: chosenComponents(state),
      stamp_id: stampIdOf(state),
      bee_url: usesExternalBee(state) ? state.beeUrl.trim() : undefined,
    };
  }

  return {
    ...shared,
    kind: 'custom',
    components: state.components,
    stamp_id: stampIdOf(state),
    // Only where no bee-uploader runs: the manager refuses a bee_url that a
    // local node would overrule, and the field is hidden in that case anyway.
    bee_url: needsExternalBeeUrl(state)
      ? state.beeUrl.trim() || undefined
      : undefined,
  };
}

function groupBody(
  state: WizardState,
  context: WizardContext,
): Omit<CreateGroupBody, 'group_name' | 'size' | 'host'> {
  // `POST /groups` takes neither of these two: an external Bee node is chosen
  // per member rather than for the group, and a pool string belongs to the ABR
  // uploader, which has no group form. Dropped here rather than sent and
  // silently ignored.
  const { bee_url, bee_publishers, ...shared } = profileBody(state, context);
  return shared;
}

function stampIdOf(state: WizardState): string | undefined {
  return state.stampMode === 'paste' ? state.stampId.trim() : undefined;
}

function poolStringOf(state: WizardState, context: WizardContext): string {
  return state.poolMode === 'pick'
    ? (poolValueIn(context, state.poolId) ?? '')
    : state.poolString.trim();
}
