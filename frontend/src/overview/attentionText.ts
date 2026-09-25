import {
  type ChequebookHealth,
  chequebookStateReason,
  type UploaderHealthReading,
} from '@streaming-infra-manager/common';

import { uploaderHealthDetail } from '../deployments/checklist';
import {
  CHEQUEBOOK_EMPTY,
  CHEQUEBOOK_LOW,
  NEEDS_A_STAMP,
  POOL_STRING_INVALID,
  STAMP_ENDS_SOON,
  STAMP_EXPIRED,
  STAMP_FULL,
  STAMP_NEARLY_FULL,
  UPLOADER_NOT_ANSWERING,
  UPLOADER_NOT_STARTED,
  UPLOADER_REPORTS_A_PROBLEM,
  UPLOADER_WAITING_FOR_NODE,
  UPLOADER_WARNED,
} from '../deployments/readiness';
import { shapeOf } from '../deployments/shape';
import type { Profile } from '../types';

/** The button a row offers beside Open, which every row has. */
export type AttentionAction =
  | 'retry'
  | 'start-uploader'
  | 'buy-stamp'
  | 'fill-chequebook'
  | 'edit';

export interface AttentionRow {
  text: string;
  action: AttentionAction | null;
}

const UPLOADER_LABELS: readonly string[] = [
  UPLOADER_REPORTS_A_PROBLEM,
  UPLOADER_WAITING_FOR_NODE,
  UPLOADER_WARNED,
  UPLOADER_NOT_ANSWERING,
];

/**
 * What one row of "Needs attention" says, and the button that fixes it.
 *
 * Keyed on the readiness label the row was listed for, so the sentence always
 * belongs to the same finding as the pill beside it. A row about the uploader
 * says what the uploader reports in the words its readiness step uses, and
 * offers only Open, because what fixes it is on the deployment's own page.
 */
export function attentionText(
  label: string,
  profile: Profile,
  chequebook: ChequebookHealth | null,
  uploaderHealth?: UploaderHealthReading,
): AttentionRow {
  if (profile.status === 'ERROR') {
    return {
      text: `Deploy failed. ${profile.last_error ?? 'No error was recorded.'}`,
      action: 'retry',
    };
  }
  if (UPLOADER_LABELS.includes(label)) {
    return {
      text: uploaderHealth ? uploaderHealthDetail(uploaderHealth, profile) : label,
      action: null,
    };
  }
  switch (label) {
    case NEEDS_A_STAMP:
      return {
        text:
          shapeOf(profile) === 'bee-node'
            ? 'No stamp yet, so its pool cannot publish to this rung.'
            : 'Running, but it cannot upload until a stamp is bought.',
        action: 'buy-stamp',
      };
    case STAMP_EXPIRED:
      return {
        text: 'The stamp ran out. Buy a new one to upload again.',
        action: 'buy-stamp',
      };
    case STAMP_FULL:
      return {
        text: 'Its stamp is full, so its node refuses uploads. Buy a new one, which is set once it is usable.',
        action: 'buy-stamp',
      };
    case STAMP_NEARLY_FULL:
      return {
        text: 'Its stamp is past 90% full. Buy the next one.',
        action: 'buy-stamp',
      };
    case UPLOADER_NOT_STARTED:
      return {
        text: 'Stamp is set. Start the uploader to finish the stack.',
        action: 'start-uploader',
      };
    case STAMP_ENDS_SOON:
      return {
        text: 'Buy the next stamp before this one runs out.',
        action: 'buy-stamp',
      };
    case CHEQUEBOOK_EMPTY:
    case CHEQUEBOOK_LOW:
      return {
        text: chequebook ? (chequebookStateReason(chequebook) ?? label) : label,
        action: 'fill-chequebook',
      };
    case POOL_STRING_INVALID:
      return {
        text: 'Its node pool string cannot be read, so the uploader will not start.',
        action: 'edit',
      };
    default:
      return { text: label, action: null };
  }
}
