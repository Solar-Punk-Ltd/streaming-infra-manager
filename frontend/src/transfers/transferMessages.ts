import { CHEQUEBOOK_ACCOUNT_CHANGED_MESSAGE } from '@streaming-infra-manager/common';
import type { TransferControllerIssue } from './TransferController';

export const TRANSFER_MESSAGES: Record<TransferControllerIssue, string> = {
  lookup_missing: 'No record was returned for this saved request. That does not prove it was never submitted. Keep this request ID.',
  lookup_unavailable: 'The saved transfer could not be checked. Keep its request ID and refresh its status later.',
  incomplete_response: 'The saved transfer response is incomplete. Its outcome needs verification.',
  response_unknown: 'The submission response was lost or could not be verified. Keep this saved request and refresh its status.',
  target_changed: 'The deployment was removed or replaced. This saved request will not be sent to its replacement.',
  target_unavailable: 'The deployment could not be checked. This saved request has not been sent by this action.',
  account_changed: CHEQUEBOOK_ACCOUNT_CHANGED_MESSAGE,
  storage_unavailable: 'This browser could not safely read or save the transfer. Sending is paused. Check saved transfers before trying again.',
  identity_conflict: 'The returned transaction identity conflicts with this saved request. Starting another transfer is blocked.',
  terminal_required: 'The current transfer still needs verification. Starting another transfer is blocked.',
  busy: 'This attempt was refused because another transfer blocks the node. Keep the saved request ID.',
  link_unavailable: 'The exact request was recovered, but its local navigation details could not be saved. Keep the request ID.',
};
