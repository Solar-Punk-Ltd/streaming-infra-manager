import { CHEQUEBOOK_ACCOUNT_CHANGED_MESSAGE, chequebookRefusalSentence, type ChequebookRefusal } from '@streaming-infra-manager/common';

const messages = {
  account_changed: CHEQUEBOOK_ACCOUNT_CHANGED_MESSAGE,
  target_changed: 'The deployment was removed or replaced. Keep the saved transfer for recovery.',
  unavailable: 'The transfer service is unavailable. Keep the saved request for recovery.',
  invalid_response: 'The transfer response could not be verified. Keep the saved request for recovery.',
  preparation_refused: 'The manager refused to prepare the transfer. Nothing was sent.',
} as const;

export class TransferApiError extends Error {
  /** Why the manager refused to prepare the transfer, drawn from the shared closed list. Set only with preparation_refused. */
  readonly refusal: ChequebookRefusal | null;

  constructor(readonly reason: keyof typeof messages, refusal: ChequebookRefusal | null = null) {
    super(reason === 'preparation_refused' && refusal ? chequebookRefusalSentence(refusal) : messages[reason]);
    this.name = 'TransferApiError';
    this.refusal = reason === 'preparation_refused' ? refusal : null;
  }
}
