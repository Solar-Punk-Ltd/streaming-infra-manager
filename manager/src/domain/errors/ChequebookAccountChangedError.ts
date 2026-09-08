import { CHEQUEBOOK_ACCOUNT_CHANGED_MESSAGE, CHEQUEBOOK_RECOVERY_ACCOUNT_CHANGED_MESSAGE } from '@streaming-infra-manager/common';

export class ChequebookAccountChangedError extends Error {
  constructor(action: 'submission' | 'recovery' = 'submission') {
    super(action === 'recovery' ? CHEQUEBOOK_RECOVERY_ACCOUNT_CHANGED_MESSAGE : CHEQUEBOOK_ACCOUNT_CHANGED_MESSAGE);
    this.name = 'ChequebookAccountChangedError';
  }
}
