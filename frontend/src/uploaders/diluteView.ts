import {
  type BeeStampTransaction,
  dilutionPreview,
  formatFillPercent,
  MAX_STAMP_DEPTH,
} from '@streaming-infra-manager/common';

import { formatTtl, NO_VALUE, shortHex } from '../format';
import type { BeeStamp } from './stampApi';

/** What a dilution costs the node's wallet, whatever the depth. */
export const DILUTE_COSTS = 'No BZZ, only the transaction fee in xDAI.';

const WHOLE_NUMBER = /^[0-9]+$/;

export interface DiluteInput {
  stamp: BeeStamp;
  /** The new depth as typed. */
  depth: string;
}

export interface DiluteView {
  depthValid: boolean;
  depthHint: string;
  /** What the whole batch and each of its buckets hold after. */
  holdsAfter: string;
  /** How full the fullest bucket is after. */
  fullAfter: string;
  lifeAfter: string;
  /**
   * Why a depth that would leave the batch under a day is refused. The postage
   * contract refuses that dilution on chain, so the dialog never sends it.
   */
  shortLife: string | null;
  confirmLabel: string;
  canConfirm: boolean;
}

/** The depth the dialog starts at, one step deeper than the batch. */
export function firstDiluteDepth(stamp: BeeStamp): number {
  return stamp.depth + 1;
}

/**
 * What the dilute dialog shows for a depth before the operator confirms, worked
 * out by `dilutionPreview`: what the batch holds, how full it is and how long it
 * lasts at that depth.
 */
export function diluteView({ stamp, depth }: DiluteInput): DiluteView {
  const typed = depth.trim();
  const newDepth = WHOLE_NUMBER.test(typed) ? Number(typed) : Number.NaN;
  const preview = dilutionPreview(stamp, newDepth);
  const lowest = firstDiluteDepth(stamp);
  if (preview === null) {
    return {
      depthValid: false,
      depthHint: `A whole depth from ${lowest} to ${MAX_STAMP_DEPTH}.`,
      holdsAfter: NO_VALUE,
      fullAfter: NO_VALUE,
      lifeAfter: NO_VALUE,
      shortLife: null,
      confirmLabel: 'Dilute',
      canConfirm: false,
    };
  }
  return {
    depthValid: true,
    depthHint: `From ${lowest} to ${MAX_STAMP_DEPTH}. Every step doubles what the batch holds and halves its life.`,
    holdsAfter: holdsText(preview.chunks, preview.bucketChunks),
    fullAfter:
      preview.fillRatio === null || preview.bucketChunks === null
        ? NO_VALUE
        : `${formatFillPercent(preview.fillRatio)}, ${stamp.utilization} of ${preview.bucketChunks} chunks in its fullest bucket`,
    lifeAfter: formatTtl(preview.ttl),
    shortLife: preview.underMinimumValidity ? shortLifeRefusal(preview.ttl) : null,
    confirmLabel: `Dilute to depth ${newDepth}`,
    canConfirm: !preview.underMinimumValidity,
  };
}

/** What the Storage card says once bee has answered a dilute. */
export function diluteSentNotice(
  stamp: BeeStamp,
  depth: number,
  sent: BeeStampTransaction,
): string {
  return `Bee sent the dilution of batch ${shortHex(stamp.batchID)} to depth ${depth} in transaction ${shortHex(sent.txHash)}, which is mined. The new depth and life show here once the node has read it back from the chain, usually within a minute.`;
}

function holdsText(chunks: number, bucketChunks: number | null): string {
  const whole = `${chunks.toLocaleString('en-GB')} chunks`;
  return bucketChunks === null
    ? whole
    : `${whole}, ${bucketChunks.toLocaleString('en-GB')} in each bucket`;
}

function shortLifeRefusal(ttl: number | null): string {
  return `That leaves ${formatTtl(ttl)}, under a day, and the postage contract refuses a dilution that leaves less than a day. Top it up first.`;
}
