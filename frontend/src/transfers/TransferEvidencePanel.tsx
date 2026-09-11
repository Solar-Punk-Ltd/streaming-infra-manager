import { Alert, Box, Stack, Typography } from '@mui/material';
import { plurToBzzExact, type ChequebookOperationDetail } from '@streaming-infra-manager/common';
import { CopyButton } from '../CopyButton';
import { hasAttributionConflict, permitsNewTransfer, transferHeadline } from './transferEvidence';
import { receiptPollingSentence } from './receiptPolling';

export function TransferValue({ label, value, copy = false }: { label: string; value: string; copy?: boolean }) {
  return <Box>
    <Typography variant="caption" color="text.secondary">{label}</Typography>
    <Stack direction="row" spacing={0.5} alignItems="flex-start">
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere', minWidth: 0, flex: 1 }}>{value}</Typography>
      {copy && <CopyButton value={value} label={label.toLowerCase()} />}
    </Stack>
  </Box>;
}

export type TransferEvidenceContext = 'saved' | 'busy' | 'previous_busy' | 'identity_conflict';

export function TransferEvidencePanel({ detail, context = 'saved' }: { detail: ChequebookOperationDetail; context?: TransferEvidenceContext }) {
  const operation = detail.operation;
  const conflict = hasAttributionConflict(detail);
  const identityConflict = context === 'identity_conflict';
  const returned = context !== 'saved';
  const prefix = identityConflict ? 'Returned' : returned ? 'Blocking' : 'Saved';
  const polling = receiptPollingSentence(operation);
  const hashes = [...new Set([operation.transactionHash, ...detail.responseEvidence.map(evidence => evidence.transactionHash)].filter((value): value is string => value !== null))];
  return <Stack spacing={1.25}>
    {context === 'busy' && <Typography variant="subtitle2">Another transfer blocks this node</Typography>}
    {context === 'previous_busy' && <>
      <Typography variant="subtitle2">Previously returned blocking operation</Typography>
      <Typography variant="body2">Shown from an earlier response. Its current status has not been checked.</Typography>
    </>}
    {identityConflict && <Typography variant="subtitle2">Conflicting returned evidence</Typography>}
    <Alert severity={conflict || identityConflict ? 'warning' : 'info'}>{identityConflict
      ? 'Returned details do not match the saved transfer. Its outcome remains unresolved.' : transferHeadline(detail)}</Alert>
    {returned && <>
      <TransferValue label={`${prefix} transfer`} value={`${operation.direction === 'deposit' ? 'Fill chequebook' : 'Withdraw from chequebook'} · ${plurToBzzExact(BigInt(operation.amountPlur))} BZZ`} />
      <TransferValue label={`${prefix} request ID`} value={operation.requestId} copy />
      <TransferValue label={`${prefix} deployment`} value={operation.profileName} />
    </>}
    <TransferValue label={`${prefix} node`} value={operation.nodeAddress} copy />
    <TransferValue label={`${prefix} chain`} value={String(operation.chainId)} />
    <TransferValue label={`${prefix} chequebook`} value={operation.chequebookAddress} copy />
    {hashes.map(hash => <TransferValue key={hash} label={returned ? `${prefix} transaction hash` : 'Transaction hash'} value={hash} copy />)}
    {conflict && <Typography variant="body2">Additional transaction evidence needs review. Starting another transfer is blocked.</Typography>}
    {!identityConflict && operation.state === 'asserted' && permitsNewTransfer(detail) && <Typography variant="body2">This records an operator's acceptance of duplicate-payment risk. It does not prove that no transaction was sent.</Typography>}
    {context === 'saved' && polling !== null && <Typography variant="body2">{polling}</Typography>}
    <TransferValue label="Last receipt check" value={operation.receiptCheckedAt ?? 'Not checked yet'} />
    <TransferValue label="Last recovery check" value={operation.recoveryCheckedAt ?? 'Not checked yet'} />
  </Stack>;
}
