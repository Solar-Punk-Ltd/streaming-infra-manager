import type { ChequebookRefusalCause } from '@streaming-infra-manager/common';
import { TransferRefusalError } from './TransferRefusalError.js';

export class ChequebookConfigurationError extends TransferRefusalError {
  constructor(cause: ChequebookRefusalCause = 'unavailable') {
    super('Invalid runtime chequebook configuration.', cause, null);
    this.name = 'ChequebookConfigurationError';
  }
}
