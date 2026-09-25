import { formatTtl } from '../format';
import { bucketFill } from './bucketFill';
import type { BeeStamp } from './stampApi';

/**
 * A batch in one line, the way the top-up and dilute dialogs name the batch
 * they change: its depth, its life left and how full its fullest bucket is.
 */
export function batchSummaryLine(stamp: BeeStamp): string {
  const fill = bucketFill(stamp);
  const parts = [`Depth ${stamp.depth}`, `${formatTtl(stamp.batchTTL)} left`];
  if (fill.chunks) {
    parts.push(`${fill.percent} full, ${fill.chunks} chunks in its fullest bucket`);
  }
  return parts.join(' · ');
}
