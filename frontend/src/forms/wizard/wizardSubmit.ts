import { ABR_LADDER_SIZE } from '@streaming-infra-manager/common';

import { routes } from '../../app/router';
import {
  createDeploymentGroup,
  createProfile,
  type CreateGroupBody,
} from '../../data';
import type { CreateProfileBody, Profile } from '../../types';
import { addressForKey } from '../validation';
import {
  chosenComponents,
  chosenHost,
  chosenKey,
  chosenPassphrase,
  needsExternalBeeUrl,
  needsFeedOwner,
  needsPassphrase,
  needsStreamKey,
  poolValueIn,
  usesExternalBee,
  type WizardContext,
  type WizardState,
} from './wizardState';

/** What the dialog does once the manager has accepted the deployment. */
export interface WizardOutcome {
  profiles: Profile[];
  /** Hash route of the thing that was just created. */
  route: string;
  toast: string;
}

export async function submitWizard(
  state: WizardState,
  context: WizardContext,
): Promise<WizardOutcome> {
  const toast = `Deploying ${state.name}…`;

  if (state.goal === 'abr-pool') {
    const result = await createDeploymentGroup({
      group_name: state.name,
      size: ABR_LADDER_SIZE,
      abr_ladder: true,
      kind: 'custom',
      host: chosenHost(state),
      notes: notesOf(state),
    });
    return { profiles: result.profiles, route: routes.group(result.group.id), toast };
  }

  if (state.group) {
    const result = await createDeploymentGroup({
      ...groupBody(state, context),
      group_name: state.name,
      size: Number(state.size),
      host: chosenHost(state),
    });
    return { profiles: result.profiles, route: routes.group(result.group.id), toast };
  }

  const profile = await createProfile({
    ...profileBody(state, context),
    name: state.name,
    host: chosenHost(state),
  });
  return { profiles: [profile], route: routes.deployment(profile.name), toast };
}

function notesOf(state: WizardState): string | null {
  return state.notes.trim() || null;
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
  };
}

function profileBody(
  state: WizardState,
  context: WizardContext,
): Omit<CreateProfileBody, 'name' | 'host'> {
  const shared = sharedBody(state, context);

  if (state.goal === 'viewer') {
    return { kind: 'viewer', notes: shared.notes, feed_owner: shared.feed_owner };
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
  // `POST /groups` takes neither an external Bee node nor a pool string: the
  // first is per member and the second belongs to a kind that has no group
  // form. Dropped here rather than sent and silently ignored.
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
