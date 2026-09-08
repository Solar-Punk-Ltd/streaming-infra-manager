import { type ChequebookHealth, stampHealthFrom, type StampHealth } from '@streaming-infra-manager/common';

import type { Tone } from '../components/tone';
import type { Profile } from '../types';
import { buildChecklist, firstBlocker, type ChecklistInput, type StepState } from './checklist';
import { shapeOf } from './shape';

export { ownsBeeNode } from '@streaming-infra-manager/common';
export { isStreamLike } from './shape';

export interface Readiness {
  label: string;
  tone: Tone;
  working?: boolean;
}

export const NEEDS_A_STAMP = 'Needs a stamp';
export const STAMP_EXPIRED = 'Stamp expired';
export const UPLOADER_NOT_STARTED = 'Uploader not started';
export const STAMP_ENDS_SOON = 'Stamp ends soon';
export const POOL_STRING_INVALID = 'Pool string invalid';
export const CHEQUEBOOK_EMPTY = 'Chequebook empty';
export const CHEQUEBOOK_LOW = 'Chequebook low';

const STEP_TONES: Record<StepState, Tone> = { ok: 'ok', warn: 'warn', err: 'err', busy: 'info', off: 'gray' };

export function readinessFor(input: ChecklistInput): Readiness {
  const blocker = firstBlocker(buildChecklist(input));
  if (blocker) return { label: blocker.problem ?? blocker.title, tone: STEP_TONES[blocker.state] };
  return { label: shapeOf(input.profile) === 'bee-node' ? 'Node prerequisites checked' : 'Containers running', tone: 'ok' };
}

/** A list without current node observations cannot verify publishing readiness. */
export function readinessOf(profile: Profile, health?: StampHealth, chequebook?: ChequebookHealth | null): Readiness {
  return readinessFor({
    profile, stampHealth: health ?? stampHealthFrom(profile.stamp_id, null),
    chequebook: chequebook ?? null, wallet: null, nodeAddress: null,
    currentStamp: null, publishUrl: null, clientUrl: null, streamers: [],
  });
}

export function needsAttention(profile: Profile, health?: StampHealth, chequebook?: ChequebookHealth | null): boolean {
  const tone = readinessOf(profile, health, chequebook).tone;
  return tone === 'warn' || tone === 'err';
}
