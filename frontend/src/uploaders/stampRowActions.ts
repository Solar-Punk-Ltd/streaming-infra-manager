import { isStampExpired, MAX_STAMP_DEPTH } from '@streaming-infra-manager/common';

import { bucketFill } from './bucketFill';
import type { BeeStamp } from './stampApi';

/** Whether a row's control can be pressed, and what the row says beside it. */
export interface RowAction {
  enabled: boolean;
  /** Why it cannot be pressed, where nothing else on the row says so already. */
  note: string | null;
}

export interface StampRowActions {
  /** Set this batch on the deployment. */
  use: RowAction;
  /** Buy this batch more life. */
  topUp: RowAction;
  /** Buy this batch more room, for half its life every step. */
  dilute: RowAction;
}

/**
 * Why a full immutable batch cannot be set. Its node refuses the uploads that
 * land in its full bucket, so setting it records a batch that cannot pay.
 */
const FULL_BATCH_NOTE = 'full, dilute it first';

/**
 * The controls of one stamps table row, all off while another change is in
 * flight. An expired batch and one not usable yet are off without a note,
 * because the row's Usable column names both.
 */
export function stampRowActions(stamp: BeeStamp, busy: boolean): StampRowActions {
  const live = stamp.usable && !isStampExpired(stamp);
  const full = bucketFill(stamp).warning === 'full';
  const deepest = stamp.depth >= MAX_STAMP_DEPTH;
  return {
    use: {
      enabled: !busy && live && !full,
      note: full ? FULL_BATCH_NOTE : null,
    },
    topUp: { enabled: !busy && live, note: null },
    dilute: {
      enabled: !busy && live && !deepest,
      note: deepest ? `already at depth ${MAX_STAMP_DEPTH}` : null,
    },
  };
}
