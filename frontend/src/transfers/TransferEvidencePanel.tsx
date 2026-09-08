import { Alert, Box, Stack, Typography } from '@mui/material';
import { plurToBzzExact, type ChequebookOperationDetail } from '@streaming-infra-manager/common';
import { CopyButton } from '../CopyButton';
import { hasAttributionConflict, permitsNewTransfer, transferHeadline } from './transferEvidence';

export function TransferValue({ label, value, copy = false }: { label: string; value: string; copy?: boolean }) {
  return <Box>
    <Typography variant="caption" color="text.secondary">{label}</Typography>
    <Stack direction="row" spacing={0.5} alignItems="flex-start">
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere', minWidth: 0, flex: 1 }}>{value}</Typography>
      {copy && <CopyButton value={value} label={label.toLowerCase()} />}
    </Stack>
  </Box>;
}

export function TransferEvidencePanel({ detail, blocking = false }: { detail: ChequebookOperationDetail; blocking?: boolean }) {
  const operation = detail.operation;
  const conflict = hasAttributionConflict(detail);
  const hashes = [...new Set([operation.transactionHash, ...detail.responseEvidence.map(evidence => evidence.transactionHash)].filter((value): value is string => value !== null))];
  return <Stack spacing={1.25}>
    {blocking && <Typography variant="subtitle2">Another transfer blocks this node</Typography>}
    <Alert severity={conflict ? 'warning' : 'info'}>{transferHeadline(detail)}</Alert>
    {blocking && <>
      <TransferValue label="Blocking transfer" value={`${operation.direction === 'deposit' ? 'Fill chequebook' : 'Withdraw from chequebook'} · ${plurToBzzExact(BigInt(operation.amountPlur))} BZZ`} />
      <TransferValue label="Blocking request ID" value={operation.requestId} copy />
      <TransferValue label="Blocking deployment" value={operation.profileName} />
    </>}
    <TransferValue label={blocking ? 'Blocking node' : 'Saved node'} value={operation.nodeAddress} copy />
    <TransferValue label={blocking ? 'Blocking chain' : 'Saved chain'} value={String(operation.chainId)} />
    <TransferValue label={blocking ? 'Blocking chequebook' : 'Saved chequebook'} value={operation.chequebookAddress} copy />
    {hashes.map(hash => <TransferValue key={hash} label={blocking ? 'Blocking transaction hash' : 'Transaction hash'} value={hash} copy />)}
    {conflict && <Typography variant="body2">Additional transaction evidence needs review. Starting another transfer is blocked.</Typography>}
    {operation.state === 'asserted' && permitsNewTransfer(detail) && <Typography variant="body2">This records an operator's acceptance of duplicate-payment risk. It does not prove that no transaction was sent.</Typography>}
    <TransferValue label="Last transaction check" value={operation.receiptCheckedAt ?? operation.recoveryCheckedAt ?? 'Not checked yet'} />
  </Stack>;
}
