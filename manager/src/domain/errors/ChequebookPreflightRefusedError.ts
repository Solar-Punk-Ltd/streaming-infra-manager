import type { ChequebookPreflightRefusal } from '@streaming-infra-manager/common';

/**
 * The last check before sending found that the node cannot pay for this
 * transfer. It is recorded on the operation as its failure reason and is never
 * answered as an error.
 */
export class ChequebookPreflightRefusedError extends Error {
  constructor(readonly reason: Exclude<ChequebookPreflightRefusal, 'preflight_failed'>) {
    super('The node cannot pay for this transfer.');
    this.name = 'ChequebookPreflightRefusedError';
  }
}
