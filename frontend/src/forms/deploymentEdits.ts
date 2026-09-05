import {
  BEE_UPLOADER_SERVICE,
  beePublishersProblem,
  beeUrlProblem,
  CLIENT_SERVICE,
  DEFAULT_ABR_RUNGS,
  parseBeePublishers,
  SRS_SERVICE,
  STREAM_UPLOADER_SERVICE,
} from '@streaming-infra-manager/common';

import { isStreamLike } from '../deployments/readiness';
import { hasService, shapeOf } from '../deployments/shape';
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
    poolString: shape === 'abr-uploader',
    feedOwner: hasService(profile, CLIENT_SERVICE),
  };
}

export function initialEdits(profile: Profile | null): DeploymentEdits {
  return {
    passMode: profile?.srt_passphrase?.trim() ? 'own' : 'host',
    passphrase: profile?.srt_passphrase ?? '',
    key: profile?.private_key ?? '',
    stampId: profile?.stamp_id ?? '',
    beeUrl: profile?.bee_url ?? '',
    poolString: profile?.bee_publishers ?? '',
    feedOwner: profile?.feed_owner ?? '',
    notes: profile?.notes ?? '',
  };
}

export function editProblem(edits: DeploymentEdits, shown: ShownFields): string | null {
  if (shown.passphrase && edits.passMode === 'own') {
    const problem = passphraseProblem(edits.passphrase);
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
 */
export function bodyFor(
  profile: Profile,
  initial: DeploymentEdits,
  edits: DeploymentEdits,
  shown: ShownFields,
): UpdateProfileBody {
  const changed = (field: keyof DeploymentEdits) =>
    edits[field] !== initial[field];

  const body: UpdateProfileBody = {
    kind: profile.kind,
    components: profile.components ?? undefined,
    notes: changed('notes') ? edits.notes.trim() || null : profile.notes ?? null,
    feed_owner: profile.feed_owner ?? undefined,
    private_key: profile.private_key ?? undefined,
    public_key: profile.public_key ?? undefined,
    stamp_id: profile.stamp_id ?? undefined,
    bee_publishers: profile.bee_publishers ?? undefined,
    bee_url: profile.bee_url ?? undefined,
    srt_passphrase: profile.srt_passphrase ?? undefined,
  };

  if (shown.passphrase && (changed('passMode') || changed('passphrase'))) {
    // The host-wide choice is an omitted field, which the PUT stores as null.
    body.srt_passphrase =
      edits.passMode === 'own' ? edits.passphrase.trim() : undefined;
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
