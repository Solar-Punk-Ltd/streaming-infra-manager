import {
  formatFillPercent,
  fullestBucketFillRatio,
  isStampFull,
  isStampNearlyFull,
  stampBucketCapacity,
  type StampLike,
} from '@streaming-infra-manager/common';

import { NO_VALUE } from '../format';

/**
 * What a fill is worth warning about: a full immutable batch, which refuses
 * uploads, or a batch past the uploader's start ceiling that still takes them.
 */
export type BucketFillWarning = 'full' | 'nearly-full';

export interface BucketFill {
  /** How full the fullest bucket is, "95%", or the no-value dash. */
  percent: string;
  /** The chunks in the fullest bucket against what one bucket holds, "122 of 128". */
  chunks: string | null;
  warning: BucketFillWarning | null;
}

type FillFields = Pick<StampLike, 'utilization' | 'depth' | 'bucketDepth' | 'immutableFlag'>;

/**
 * How full a batch's fullest bucket is, the number that decides whether its
 * node refuses uploads, in the words the stamps table and the change dialogs
 * use.
 */
export function bucketFill(stamp: FillFields): BucketFill {
  const ratio = fullestBucketFillRatio(stamp);
  const capacity = stampBucketCapacity(stamp);
  if (ratio === null || capacity === null) {
    return { percent: NO_VALUE, chunks: null, warning: null };
  }
  return {
    percent: formatFillPercent(ratio),
    chunks: `${stamp.utilization} of ${capacity}`,
    warning: fillWarning(ratio, stamp.immutableFlag),
  };
}

function fillWarning(
  ratio: number,
  immutable: boolean | undefined,
): BucketFillWarning | null {
  if (isStampFull(ratio, immutable)) return 'full';
  if (isStampNearlyFull(ratio, immutable)) return 'nearly-full';
  return null;
}
