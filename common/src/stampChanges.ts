/**
 * What the changes Bee makes to a batch it already holds would leave that batch
 * with, worked out before anybody pays for one.
 *
 * Topping up adds balance for every chunk a batch holds, which buys life and
 * changes nothing else. Diluting raises a batch's depth. Every step doubles the
 * chunks the batch holds and the chunks each of its buckets holds, and halves
 * the life it has left, because the same balance now pays for twice the chunks.
 * Both keep the batch id, so nothing that names the batch has to change with it.
 */
import {
  MAX_STAMP_DEPTH,
  stampCostPlur,
  stampTtlSeconds,
} from './stampCost.js';
import {
  fullestBucketFillRatio,
  stampBucketCapacity,
  type StampFill,
} from './stampHealth.js';

/** A batch as its node reports it, the fields a change is worked out from. */
export interface StampReading extends StampFill {
  /** Seconds left. `0` is spent, and a negative value means bee could not work it out. */
  batchTTL?: number;
}

export interface DilutionPreview {
  /** Chunks the whole batch holds after, `2^depth`. */
  chunks: number;
  /** Chunks each bucket holds after, or null where the node did not report its bucket depth. */
  bucketChunks: number | null;
  /** How full the fullest bucket is after. Its count stays and what it holds doubles every step. */
  fillRatio: number | null;
  /** Seconds left after, or null where the node did not say how many it has now. */
  ttl: number | null;
}

export interface TopUpPreview {
  /** Seconds the amount adds at today's price, or null where the price is not known. */
  addedTtl: number | null;
  /** Seconds left after, or null where the life added or the life left is not known. */
  ttl: number | null;
  /** What it takes from the node's wallet, in PLUR: the amount for every chunk the batch holds. */
  costPlur: string | null;
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isKnownTtl(ttl: number | undefined): ttl is number {
  return typeof ttl === 'number' && Number.isFinite(ttl) && ttl >= 0;
}

/**
 * What diluting a batch to `newDepth` leaves it with, or null where that is no
 * dilution: a depth that is not deeper than the batch's own, one past
 * `MAX_STAMP_DEPTH`, or a batch whose own depth the node did not report.
 */
export function dilutionPreview(
  stamp: StampReading,
  newDepth: number,
): DilutionPreview | null {
  const { depth } = stamp;
  if (!isWholeNumber(depth) || !isWholeNumber(newDepth)) return null;
  if (newDepth <= depth || newDepth > MAX_STAMP_DEPTH) return null;

  const after: StampFill = { ...stamp, depth: newDepth };
  const steps = newDepth - depth;
  return {
    chunks: 2 ** newDepth,
    bucketChunks: stampBucketCapacity(after),
    fillRatio: fullestBucketFillRatio(after),
    ttl: isKnownTtl(stamp.batchTTL) ? Math.floor(stamp.batchTTL / 2 ** steps) : null,
  };
}

/**
 * What topping a batch up by `amountPerChunkPlur` adds and costs at
 * `pricePerBlockPlur`, today's price. Every part is null where what it is worked
 * out from is missing or is not a positive whole number of PLUR.
 */
export function topUpPreview(
  stamp: StampReading,
  amountPerChunkPlur: string,
  pricePerBlockPlur: string | null | undefined,
): TopUpPreview {
  const addedTtl = stampTtlSeconds(amountPerChunkPlur, pricePerBlockPlur);
  const ttlLeft = stamp.batchTTL;
  return {
    addedTtl,
    ttl: addedTtl !== null && isKnownTtl(ttlLeft) ? ttlLeft + addedTtl : null,
    costPlur: stampCostPlur(amountPerChunkPlur, stamp.depth),
  };
}
