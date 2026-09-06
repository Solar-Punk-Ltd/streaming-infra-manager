import {
  type ChequebookHealth,
  uploaderUnfundedReason,
} from '@streaming-infra-manager/common';

/**
 * A node whose chequebook is under the floor, refusing an uploader that would
 * take segments and pay for none of them.
 *
 * The message carries both numbers because the operator's next move depends on
 * the gap, and because the floor is configurable: quoting the one the gate
 * actually used is the only way the sentence stays true.
 */
export class ChequebookUnfundedError extends Error {
  constructor(
    public readonly profileName: string,
    health: ChequebookHealth,
  ) {
    super(uploaderUnfundedReason(health));
    this.name = 'ChequebookUnfundedError';
  }
}
