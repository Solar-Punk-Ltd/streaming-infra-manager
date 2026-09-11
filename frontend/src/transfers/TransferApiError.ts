import { CHEQUEBOOK_ACCOUNT_CHANGED_MESSAGE } from '@streaming-infra-manager/common';

const messages = {
  account_changed: CHEQUEBOOK_ACCOUNT_CHANGED_MESSAGE,
  target_changed: 'The deployment was removed or replaced. Keep the saved transfer for recovery.',
  unavailable: 'The transfer service is unavailable. Keep the saved request for recovery.',
  invalid_response: 'The transfer response could not be verified. Keep the saved request for recovery.',
} as const;

export class TransferApiError extends Error {
  constructor(readonly reason: keyof typeof messages) {
    super(messages[reason]);
    this.name = 'TransferApiError';
  }
}
