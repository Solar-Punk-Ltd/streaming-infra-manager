/**
 * What a *recorded* postage batch is actually worth right now.
 *
 * `profiles.stamp_id` only records which batch an uploader was pointed at. A
 * batch is a paid, finite lease: it runs out on its own, and once it does bee
 * stops accepting uploads against it and eventually drops it from `/stamps`
 * altogether. Nothing writes that back to the column, so a profile with a
 * `stamp_id` set is not the same thing as a profile that can upload, and
 * treating the two as one is what let a fully expired ladder render as
 * "4/4 rungs stamped" while every upload failed.
 *
 * The classification lives here, shared, because three places need the same
 * answer: the ladder's readiness (manager), each uploader card's chip
 * (frontend), and the deploy gate.
 */

import type { ReadFailure } from './nodeReading.js';

/**
 * What bee's `/stamps` entry says about how full a batch is.
 *
 * Every field is optional because callers hand over whatever they were given,
 * and a missing one means nobody said, never zero.
 */
export interface StampFill {
  /** Chunks in the batch's fullest bucket, not in the whole batch. */
  utilization?: number;
  /** The batch holds `2^depth` chunks. */
  depth?: number;
  /** The batch's chunks are spread over `2^bucketDepth` buckets. */
  bucketDepth?: number;
}

/** The fields of bee's `/stamps` entry that decide whether a batch can still pay. */
export interface StampLike extends StampFill {
  batchID: string;
  usable: boolean;
  /**
   * Seconds of life left. `0` means spent, and bee reports a negative value when it
   * cannot work the TTL out, which is not the same as expired.
   */
  batchTTL: number;
  exists?: boolean;
  /**
   * An immutable batch refuses the uploads that land in a full bucket. A mutable
   * one takes them and overwrites that bucket's oldest chunks instead.
   */
  immutableFlag?: boolean;
}

export type StampState =
  /** No batch recorded on the profile at all. */
  | 'none'
  /** Recorded, but its node has not been asked yet or could not answer. */
  | 'unknown'
  /** Recorded, on the node, usable: uploads will be paid for. */
  | 'active'
  /** Recorded, on the node, bought too recently to be usable yet. */
  | 'pending'
  /**
   * Recorded, on the node, immutable, and its fullest bucket is full, so the node
   * answers 402 to every upload that lands in that bucket, and to a growing share
   * of all uploads as the other buckets fill. Diluting it buys room, so it is not
   * beyond saving.
   */
  | 'full'
  /** Recorded, on the node, out of time. */
  | 'expired'
  /** Recorded, but the node no longer knows this batch, expired and dropped. */
  | 'gone';

export interface StampHealth {
  state: StampState;
  /** An upload paid with this batch would succeed. */
  ok: boolean;
  /** Beyond saving: no amount of waiting brings this batch back. Buy another. */
  dead: boolean;
  /** Seconds left, when the node said. */
  ttl: number | null;
  /** How full the fullest bucket is, see `fullestBucketFillRatio`. Null when the node did not say enough. */
  fillRatio: number | null;
  /** Whether the batch is immutable, null when the node did not say. */
  immutable: boolean | null;
  /** Why the node was not asked successfully, where it was asked and failed. */
  failure?: ReadFailure;
}

const DEAD_STATES: readonly StampState[] = ['expired', 'gone'];

/**
 * The uploader's default start ceiling, the stack's `STAMP_MAX_UTILIZATION`. An
 * uploader restarted on an immutable batch fuller than this refuses to boot, and
 * the uploader of stack v3.3 and earlier refuses a mutable one as well, which is
 * why the manager warns from here rather than only once the batch fills.
 */
export const STAMP_FILL_WARNING_RATIO = 0.9;

/** A fill that has reached its bucket's capacity. */
const FULL_RATIO = 1;

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * How many chunks one bucket of a batch holds, `2^(depth - bucketDepth)`, or null
 * when the two depths are missing, are not whole non-negative numbers, or describe
 * a batch shallower than its own buckets.
 */
export function stampBucketCapacity(stamp: StampFill): number | null {
  const { depth, bucketDepth } = stamp;
  if (!isCount(depth) || !isCount(bucketDepth) || depth < bucketDepth) return null;
  return 2 ** (depth - bucketDepth);
}

/**
 * How full a batch's fullest bucket is, as a share of what one bucket holds.
 *
 * That is the number that decides refusals, not the batch's overall fill: bee
 * spreads chunks over buckets by address, an immutable batch refuses a chunk
 * whose own bucket is full, and bee's `utilization` counts the fullest bucket
 * alone. `1` is full.
 *
 * Null whenever any of the three fields is missing or not a whole non-negative
 * number, or the depths contradict each other. Absence is never read as empty.
 */
export function fullestBucketFillRatio(stamp: StampFill): number | null {
  const capacity = stampBucketCapacity(stamp);
  if (capacity === null || !isCount(stamp.utilization)) return null;
  return stamp.utilization / capacity;
}

/**
 * A fill as a whole percentage, rounded down, so a batch one chunk short of full
 * never reads as 100%.
 */
export function formatFillPercent(fillRatio: number): string {
  return `${Math.floor(fillRatio * 100)}%`;
}

/** Whether a fill from `fullestBucketFillRatio` has reached its bucket's capacity. */
export function isFullestBucketFull(fillRatio: number | null | undefined): boolean {
  return fillRatio != null && fillRatio >= FULL_RATIO;
}

/**
 * Whether a full bucket makes this batch refuse uploads. A batch whose kind nobody
 * reported is taken to refuse, since that is the kind that fails.
 */
function refusesWhenFull(immutable: boolean | null | undefined): boolean {
  return immutable !== false;
}

function isFullAndRefusing(
  fillRatio: number | null,
  immutable: boolean | null,
): boolean {
  return isFullestBucketFull(fillRatio) && refusesWhenFull(immutable);
}

/**
 * A batch past the uploader's start ceiling that still takes uploads, the way
 * `isStampExpiringSoon` is for time.
 *
 * An immutable batch, or one of a kind nobody reported, raises it until it is
 * full, and full is not a warning but a failure, reported as `full`. A mutable
 * batch raises it full or not: bee never refuses it, but once full it overwrites
 * the oldest chunks it paid for, and the uploader of stack v3.3 and earlier holds
 * it to the same start ceiling.
 */
export function isStampNearlyFull(
  fillRatio: number | null | undefined,
  immutable: boolean | null | undefined,
): boolean {
  if (fillRatio == null || fillRatio <= STAMP_FILL_WARNING_RATIO) return false;
  return !refusesWhenFull(immutable) || !isFullestBucketFull(fillRatio);
}

/**
 * What a batch past the start ceiling leads to, by its kind, for the warnings
 * that name it. Shared so the checklist, the pool and the Storage card agree.
 */
export function nearlyFullConsequence(
  immutable: boolean | null | undefined,
  fillRatio?: number | null,
): string {
  if (refusesWhenFull(immutable)) {
    return 'Past 90% an uploader restarted on it refuses to start, and once it fills its node refuses uploads.';
  }
  return isFullestBucketFull(fillRatio)
    ? 'Its node now overwrites its oldest chunks, so the oldest recordings paid with it are losing data, and the uploader of stack v3.3 and earlier refuses to restart on it.'
    : 'Once it fills its node overwrites its oldest chunks, so the oldest recordings paid with it start losing data, and past 90% the uploader of stack v3.3 and earlier refuses to restart on it.';
}

/**
 * How much life left in a batch is worth warning about.
 *
 * The point of a warning is that four rungs can still be topped up while they are
 * alive. Once one is spent that rung's uploads have already been failing. Two days
 * is chosen against how the ladder is sized: the rungs' depths are deliberately
 * staggered (17/18/19/20) so the four expiries land hours apart rather than
 * together, and this needs to be wide enough to catch the first one and still be
 * showing when the last goes.
 */
export const STAMP_EXPIRY_WARNING_SECONDS = 48 * 60 * 60;

/**
 * A batch that is still paying but will not be for long.
 *
 * A negative TTL is bee saying it cannot work the remaining time out, not that
 * the time is short. It must not raise this.
 */
export function isStampExpiringSoon(
  ttl: number | null | undefined,
  within: number = STAMP_EXPIRY_WARNING_SECONDS,
): boolean {
  return ttl != null && ttl > 0 && ttl <= within;
}

/**
 * A batch in this state is beyond saving: waiting will not revive it and there is
 * no top-up to apply, so the only way out is buying another one.
 */
export function isDeadStampState(
  state: StampState | null | undefined,
): boolean {
  return state != null && DEAD_STATES.includes(state);
}

/** True once a batch has spent its last second. Purely about the clock. */
export function isStampExpired(stamp: StampLike): boolean {
  return stamp.batchTTL === 0;
}

export function sameBatchId(a: string, b: string): boolean {
  return a.replace(/^0x/, '') === b.replace(/^0x/, '');
}

/**
 * Classify the batch recorded on a profile against what its bee node reports.
 *
 * `stamps` is the node's list, or `null` for "not asked, or the node did not
 * answer". The distinction matters: an empty list means the batch is gone,
 * whereas no list at all means we do not know, and a node being down must never
 * be reported as an expired batch.
 *
 * `failure` says why there is no list, and is kept only where there is none to
 * have: attached to a list the node did give, it would be a reason for nothing.
 */
export function stampHealthFrom(
  stampId: string | null | undefined,
  stamps: readonly StampLike[] | null,
  failure?: ReadFailure,
): StampHealth {
  if (!stampId || !stampId.trim()) return health('none');
  if (stamps === null) return health('unknown', undefined, failure);

  const found = stamps.find((stamp) => sameBatchId(stamp.batchID, stampId));
  // A node that disowns the batch is telling us the same thing as one that has
  // dropped it from the list: it is not there any more.
  if (!found || found.exists === false) return health('gone');

  const reading: NodeReading = {
    ttl: found.batchTTL,
    fillRatio: fullestBucketFillRatio(found),
    immutable: found.immutableFlag ?? null,
  };
  if (isStampExpired(found)) return health('expired', reading);
  if (!found.usable) return health('pending', reading);
  // bee goes on calling a full immutable batch usable, with time left, while it
  // refuses every upload that lands in the full bucket.
  if (isFullAndRefusing(reading.fillRatio, reading.immutable)) {
    return health('full', reading);
  }
  return health('active', reading);
}

/** What the node said about the batch it holds. Nothing, where it was not asked or holds none. */
interface NodeReading {
  ttl: number;
  fillRatio: number | null;
  immutable: boolean | null;
}

function health(
  state: StampState,
  reading?: NodeReading,
  failure?: ReadFailure,
): StampHealth {
  return {
    state,
    ok: state === 'active',
    dead: DEAD_STATES.includes(state),
    ttl: reading?.ttl ?? null,
    fillRatio: reading?.fillRatio ?? null,
    immutable: reading?.immutable ?? null,
    ...(failure ? { failure } : {}),
  };
}

/**
 * Why a batch in this state cannot be published with, phrased for an operator
 * reading a list of rungs. Shared so the ladder's readiness and each card's
 * warning cannot drift apart.
 */
export function stampStateReason(state: StampState): string | null {
  switch (state) {
    case 'none':
      return 'no postage batch set on this rung yet';
    case 'expired':
      return 'the postage batch on this rung has expired — buy a new one';
    case 'gone':
      return 'this rung’s bee node no longer holds the batch recorded for it — buy a new one';
    case 'pending':
      return 'the postage batch on this rung is not usable yet — bee is still settling it';
    case 'full':
      return 'the postage batch on this rung is full, so its node refuses uploads. Buy a new one on the rung’s page';
    case 'active':
    case 'unknown':
      return null;
  }
}
