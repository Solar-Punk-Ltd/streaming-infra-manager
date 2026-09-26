import type { ChequebookRefusalCause } from '@streaming-infra-manager/common';
import { TransferRefusalError } from './TransferRefusalError.js';

export class ChainReadError extends TransferRefusalError {
  constructor(cause: ChequebookRefusalCause = 'chain_unreachable') {
    super('The chain could not be read. The transfer outcome remains unverified.', cause, null);
    this.name = 'ChainReadError';
  }

  /** A fresh error that keeps the cause a caught manager error carried, so the caught error goes no further. */
  static keeping(error: unknown, fallback: ChequebookRefusalCause = 'chain_unreachable'): ChainReadError {
    const carried = TransferRefusalError.carried(error);
    return new ChainReadError(carried ? carried.cause : fallback);
  }
}
