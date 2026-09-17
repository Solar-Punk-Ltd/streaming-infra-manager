import {
  BEE_UPLOADER_SERVICE,
  beePublishersProblem,
  beeUrlProblem,
  CLIENT_SERVICE,
  CUSTOM_RPC_ENDPOINT_SOURCE,
  DEFAULT_ABR_RUNGS,
  DEFAULT_RPC_ENDPOINT_SOURCE,
  defaultServicesFor,
  effectiveNodeMode,
  LIGHT_NODE_MODE,
  parseBeePublishers,
  type RpcEndpointSource,
  rpcEndpointChoiceProblem,
  SRS_SERVICE,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

import { isStreamLike } from '../deployments/readiness';
import { endpointSourceOf, hasService, ownsAnyBeeNode, shapeOf } from '../deployments/shape';
import type { UpdateProfileBody } from '../data';
import type { Profile } from '../types';
import type { PassphraseMode } from './PassphraseField';
import {
  addressForKey,
  addressProblem,
  notesProblem,
  passphraseProblem,
  privateKeyProblem,
  stampIdProblem,
} from './validation';

/** Everything the deployment drawer lets an operator change. */
export interface DeploymentEdits {
  passMode: PassphraseMode;
  passphrase: string;
  key: string;
  stampId: string;
  beeUrl: string;
  rpcEndpointSource: RpcEndpointSource;
  /** The address behind the custom source. Empty under the other two. */
  rpcEndpoint: string;
  poolString: string;
  feedOwner: string;
  notes: string;
}

/** Which questions this deployment's services make worth asking. */
export interface ShownFields {
  passphrase: boolean;
  key: boolean;
  stamp: boolean;
  beeUrl: boolean;
  rpcEndpoint: boolean;
  poolString: boolean;
  feedOwner: boolean;
}

export function fieldsFor(profile: Profile): ShownFields {
  const shape = shapeOf(profile);
  const streamLike = isStreamLike(profile, shape);
  return {
    passphrase: hasService(profile, SRS_SERVICE),
    key: hasService(profile, STREAM_UPLOADER_SERVICE),
    stamp: streamLike,
    beeUrl: streamLike && !hasService(profile, BEE_UPLOADER_SERVICE),
    // A light node and nothing else. An ultra-light one is what bee reads off
    // an EMPTY --blockchain-rpc-endpoint (pkg/node/node.go:1605
    // isChainEnabled), so there is nowhere for an endpoint to go and the field
    // would offer a setting that changes nothing. Which a viewer's gateway is
    // depends on how it was created, since T27.
    rpcEndpoint: ownsAnyBeeNode(profile) && effectiveNodeMode(profile) === LIGHT_NODE_MODE,
    poolString: shape === 'abr-uploader',
    feedOwner: hasService(profile, CLIENT_SERVICE),
  };
}

export function initialEdits(profile: Profile | null): DeploymentEdits {
  return {
    // The flag, because the value is not on the row. A deployment that holds
    // one is on its own passphrase whatever that passphrase turns out to be.
    passMode: profile?.has_srt_passphrase ? 'own' : 'host',
    // Empty whatever the deployment holds, for the reason the key box is: the
    // value is not answered onto the row, so only what the operator types goes
    // in it.
    passphrase: '',
    key: '',
    stampId: profile?.stamp_id ?? '',
    beeUrl: profile?.bee_url ?? '',
    rpcEndpointSource: profile ? endpointSourceOf(profile) : DEFAULT_RPC_ENDPOINT_SOURCE,
    rpcEndpoint: profile?.rpc_endpoint ?? '',
    poolString: profile?.bee_publishers ?? '',
    feedOwner: profile?.feed_owner ?? '',
    notes: profile?.notes ?? '',
  };
}

/** What the stream key field is looking at, which decides whether it shows dots. */
export interface StreamKeyState {
  /** Whether the deployment holds a key, which is all the manager answers. */
  hasStoredKey: boolean;
  /** What the operator has typed or generated, empty until they do. */
  typed: string;
  /** Whether they asked to replace the stored key, which opens the empty box. */
  replacing: boolean;
}

/**
 * Whether the field shows dots instead of a value.
 *
 * There is no key to show: the manager answers whether one is stored and never
 * the key. So the field is masked exactly while a key is stored, nothing has
 * been typed, and the operator has not asked to replace it.
 */
export function streamKeyMasked(state: StreamKeyState): boolean {
  return state.hasStoredKey && !state.replacing && state.typed === '';
}

/** What the SRT passphrase field is looking at, which decides whether it shows dots. */
export interface SrtPassphraseState {
  /** Whether the deployment holds a passphrase, which is all the row says. */
  hasStoredPassphrase: boolean;
  /** What the operator has typed or generated, empty until they do. */
  typed: string;
  /** Whether they asked to replace the stored one, which opens the empty box. */
  replacing: boolean;
}

/**
 * Whether the field shows dots instead of a value.
 *
 * There is no passphrase to show: the row says only whether one is stored, and
 * the value is answered to the page building a publish URL rather than to a
 * drawer. So the field is masked exactly while one is stored, nothing has been
 * typed, and the operator has not asked to replace it.
 */
export function srtPassphraseMasked(state: SrtPassphraseState): boolean {
  return state.hasStoredPassphrase && !state.replacing && state.typed === '';
}

/** What the drawer knows about the deployment that the edits themselves do not say. */
export interface EditContext {
  profile: Profile;
  /** Whether this manager has a chain endpoint of its own to offer. */
  managerHasEndpoint: boolean;
}

export function editProblem(
  edits: DeploymentEdits,
  shown: ShownFields,
  { profile, managerHasEndpoint }: EditContext,
): string | null {
  const hasStoredPassphrase = profile.has_srt_passphrase;
  if (shown.passphrase && edits.passMode === 'own') {
    // Dots standing for a stored passphrase are not a value to check: the save
    // says nothing about it and the manager keeps it. Anything else in the box
    // has to be a passphrase the engine will take.
    const keepsStored = srtPassphraseMasked({
      hasStoredPassphrase,
      typed: edits.passphrase,
      replacing: false,
    });
    const problem = keepsStored ? null : passphraseProblem(edits.passphrase);
    if (problem) return problem;
  }
  if (shown.key && edits.key.trim()) {
    const problem = privateKeyProblem(edits.key);
    if (problem) return problem;
  }
  if (shown.stamp && edits.stampId.trim()) {
    const problem = stampIdProblem(edits.stampId);
    if (problem) return problem;
  }
  if (shown.beeUrl) {
    const problem = beeUrlProblem(edits.beeUrl);
    if (problem) return problem;
  }
  if (shown.rpcEndpoint) {
    // The shared rule, asked with what the save will carry, so the drawer
    // refuses exactly what the manager would rather than sending a filled-in
    // form to be refused at the API.
    const problem = rpcEndpointChoiceProblem({
      source: edits.rpcEndpointSource,
      url: edits.rpcEndpointSource === CUSTOM_RPC_ENDPOINT_SOURCE ? edits.rpcEndpoint : '',
      managerHasEndpoint,
      nodeMode: effectiveNodeMode(profile),
      services: defaultServicesFor(profile),
    });
    if (problem) return `Chain endpoint: ${problem}`;
  }
  if (shown.poolString) {
    if (!edits.poolString.trim()) {
      return 'Paste the pool string, copied from a pool page';
    }
    const problem = beePublishersProblem(edits.poolString);
    if (problem) return problem;
  }
  if (shown.feedOwner) {
    const problem = addressProblem(edits.feedOwner);
    if (problem) return problem;
  }
  return notesProblem(edits.notes);
}

/** Whether the operator changed anything since the form opened. */
export function hasEdits<T extends object>(initial: T, edits: T): boolean {
  return (Object.keys(initial) as (keyof T)[]).some(
    (field) => edits[field] !== initial[field],
  );
}

/**
 * The PUT replaces every editable field, so the body starts from what the
 * profile holds right now and only the fields the operator changed are
 * overlaid. Untouched fields take the live value, not the value that was on
 * screen when the drawer opened: a stamp that settled while the operator was
 * typing a note has to survive the save.
 *
 * An edited note goes with the revision the drawer loaded it at, so a note
 * saved from the Notes card since is a refusal from the manager rather than
 * an overwrite.
 */
export function bodyFor(
  profile: Profile,
  initial: DeploymentEdits,
  edits: DeploymentEdits,
  shown: ShownFields,
  loadedNotesRevision: number,
): UpdateProfileBody {
  const changed = (field: keyof DeploymentEdits) =>
    edits[field] !== initial[field];

  const body: UpdateProfileBody = {
    kind: profile.kind,
    components: profile.components ?? undefined,
    notes: changed('notes') ? edits.notes.trim() || null : profile.notes ?? null,
    feed_owner: profile.feed_owner ?? undefined,
    public_key: profile.public_key ?? undefined,
    stamp_id: profile.stamp_id ?? undefined,
    bee_publishers: profile.bee_publishers ?? undefined,
    bee_url: profile.bee_url ?? undefined,
    rpc_endpoint: profile.rpc_endpoint ?? undefined,
    rpc_endpoint_source: endpointSourceOf(profile),
    // A node's mode is chosen when it is created and the manager refuses a body
    // that names a different one, so the stored one goes back untouched. A
    // deployment that stores none sends none: the mode it reads as would fill
    // that column in as a side effect of saving a note.
    ...(profile.node_mode ? { node_mode: profile.node_mode } : {}),
  };

  if (changed('notes')) {
    body.notes_revision = loadedNotesRevision;
  }
  if (shown.passphrase) {
    // Absent is what keeps the stored passphrase, so the host-wide choice has
    // to be an explicit null. An own passphrase is sent only when the operator
    // typed one, because an empty box under that mode stands for the stored
    // one and sending nothing is what keeps it.
    if (edits.passMode === 'host') {
      if (changed('passMode')) body.srt_passphrase = null;
    } else if (edits.passphrase.trim()) {
      body.srt_passphrase = edits.passphrase.trim();
    }
  }
  const key = edits.key.trim();
  // Re-deriving an unchanged key would quietly rewrite a public_key that
  // disagrees with it, which is a stream's identity.
  if (shown.key && changed('key') && key) {
    body.private_key = key;
    body.public_key = addressForKey(key) ?? undefined;
  }
  if (shown.stamp && changed('stampId')) {
    body.stamp_id = edits.stampId.trim() || undefined;
  }
  if (shown.beeUrl && changed('beeUrl')) {
    body.bee_url = edits.beeUrl.trim() || null;
  }
  // The address and the custom source travel together and only together, which
  // is the manager's own column pairing: moving off custom takes the stored
  // address with it rather than leaving one nothing reads.
  if (shown.rpcEndpoint && (changed('rpcEndpointSource') || changed('rpcEndpoint'))) {
    const custom = edits.rpcEndpointSource === CUSTOM_RPC_ENDPOINT_SOURCE;
    body.rpc_endpoint_source = edits.rpcEndpointSource;
    body.rpc_endpoint = custom ? edits.rpcEndpoint.trim() || null : null;
  }
  if (shown.poolString && changed('poolString')) {
    body.bee_publishers = edits.poolString.trim() || null;
  }
  if (shown.feedOwner && changed('feedOwner')) {
    body.feed_owner = edits.feedOwner.trim() || undefined;
  }

  return body;
}

export function poolHint(value: string): string {
  const rungs = parseBeePublishers(value)?.length ?? 0;
  return rungs === DEFAULT_ABR_RUNGS.length
    ? `${rungs} rungs recognised.`
    : 'Needs all four rungs, as copied from a pool page.';
}
