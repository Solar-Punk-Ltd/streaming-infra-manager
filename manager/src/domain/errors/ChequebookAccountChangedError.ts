import { CHEQUEBOOK_ACCOUNT_CHANGED_MESSAGE } from '@streaming-infra-manager/common';

export class ChequebookAccountChangedError extends Error {
  constructor() {
    super(CHEQUEBOOK_ACCOUNT_CHANGED_MESSAGE);
    this.name = 'ChequebookAccountChangedError';
  }
}
