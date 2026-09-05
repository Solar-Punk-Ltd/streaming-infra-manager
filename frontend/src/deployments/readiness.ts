import {
  beePublishersProblem,
  hasStampId,
  isStampExpiringSoon,
  type StampHealth,
  STREAM_UPLOADER_SERVICE,
  usesNodePool,
} from '@streaming-infra-manager/common';

import type { Tone } from '../components/tone';
import { canDeployUploader } from '../data';
import type { Profile } from '../types';
import { hasService, shapeOf, statusLabelOf } from './shape';

export interface Readiness {
  label: string;
  tone: Tone;
}

const READY_TO_STREAM = 'Ready to stream';
export const NEEDS_A_STAMP = 'Needs a stamp';
export const STAMP_EXPIRED = 'Stamp expired';
export const UPLOADER_NOT_STARTED = 'Uploader not started';
export const STAMP_ENDS_SOON = 'Stamp ends soon';
export const POOL_STRING_INVALID = 'Pool string invalid';

/**
 * Whether a deployment can do the job it exists for, in one phrase.
 *
 * `health` is what the deployment's own Bee node says about the batch recorded
 * on it, and is only known on a page that asked. Without it a recorded
 * `stamp_id` is taken at face value, which is the most that can honestly be
 * said from the profile list alone.
 */
export function readinessOf(
  profile: Profile,
  health?: StampHealth,
): Readiness {
  if (profile.status !== 'RUNNING') {
    const status = statusLabelOf(profile);
    if (profile.status === 'ERROR') return { label: 'Failed', tone: 'err' };
    if (profile.status === 'STOPPED') return { label: 'Stopped', tone: 'gray' };
    return { label: `${status.label}…`, tone: status.tone };
  }

  const shape = shapeOf(profile);

  if (shape === 'abr-uploader') {
    return beePublishersProblem(profile.bee_publishers)
      ? { label: POOL_STRING_INVALID, tone: 'err' }
      : { label: READY_TO_STREAM, tone: 'ok' };
  }

  if (isStreamLike(profile, shape)) {
    if (profile.pendingStamp || !hasStampId(profile)) {
      return { label: NEEDS_A_STAMP, tone: 'warn' };
    }
    if (canDeployUploader(profile)) {
      return { label: UPLOADER_NOT_STARTED, tone: 'warn' };
    }
    const stamp = stampReadiness(health);
    return stamp ?? { label: READY_TO_STREAM, tone: 'ok' };
  }

  if (shape === 'viewer') return { label: 'Watchable', tone: 'ok' };

  if (shape === 'bee-node') {
    if (!hasStampId(profile)) return { label: NEEDS_A_STAMP, tone: 'warn' };
    if (health?.dead) return { label: STAMP_EXPIRED, tone: 'err' };
    if (health?.state === 'pending') {
      return { label: 'Stamp settling', tone: 'info' };
    }
    return { label: 'Stamped', tone: 'ok' };
  }

  return { label: 'Running', tone: 'ok' };
}

/** Warn or worse: the deployment needs a hand before it can do its job. */
export function needsAttention(
  profile: Profile,
  health?: StampHealth,
): boolean {
  const tone = readinessOf(profile, health).tone;
  return tone === 'warn' || tone === 'err';
}

/**
 * A deployment whose readiness runs through funding, a stamp and an uploader:
 * a stream, or a custom that publishes to Swarm from its own node.
 */
export function isStreamLike(
  profile: Profile,
  shape = shapeOf(profile),
): boolean {
  if (shape === 'stream') return true;
  return (
    shape === 'custom' &&
    hasService(profile, STREAM_UPLOADER_SERVICE) &&
    !usesNodePool(profile)
  );
}

function stampReadiness(health?: StampHealth): Readiness | null {
  if (!health) return null;
  if (health.dead) return { label: STAMP_EXPIRED, tone: 'err' };
  if (health.state === 'pending') {
    return { label: 'Stamp settling', tone: 'info' };
  }
  if (isStampExpiringSoon(health.ttl)) {
    return { label: STAMP_ENDS_SOON, tone: 'warn' };
  }
  return null;
}
