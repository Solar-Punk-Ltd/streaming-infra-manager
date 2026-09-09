import { CHEQUEBOOK_OPERATION_CHANGED_MESSAGE } from '@streaming-infra-manager/common';

export class ChequebookOperationChangedError extends Error {
  constructor() {
    super(CHEQUEBOOK_OPERATION_CHANGED_MESSAGE);
    this.name = 'ChequebookOperationChangedError';
  }
}
