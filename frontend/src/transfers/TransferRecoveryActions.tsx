import { useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Paper, Stack, TextField, Typography } from '@mui/material';
import type { ChequebookOperationDetail } from '@streaming-infra-manager/common';
import { TransferValue } from './TransferEvidencePanel';
import { canAssertTransfer, canCheckTransfer } from './transferRecoveryEligibility';
import { useTransferRecovery, type RecoveryNotice } from './useTransferRecovery';

export function TransferRecoveryActions({ detail, accountId, finished, notice }: {
  detail: ChequebookOperationDetail; accountId: number; notice: RecoveryNotice | null; finished: (notice: RecoveryNotice) => void;
}) {
  const recovery = useTransferRecovery(detail, accountId, finished);
  const [transactionHash, setTransactionHash] = useState('');
  const suppliedHash = transactionHash.trim().toLowerCase();
  const operation = detail.operation;
  const recoverable = canCheckTransfer(detail);
  const assertion = recovery.assertion;
  const checkLabel = operation.state === 'submitted' ? 'Check transaction receipt'
    : operation.recoveryObservation?.scan?.complete === false ? 'Continue transaction search' : 'Search transaction history';
  return <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 } }}>
    <Stack spacing={2}>
      <Typography variant="h6">Recovery actions</Typography>
      {notice && <Alert severity={notice.severity}>{notice.message}</Alert>}
      <Typography variant="body2">These actions use the saved transfer identity. They do not send BZZ. Each check is requested once and may update recorded evidence.</Typography>
      <Typography variant="body2">You are using the current signed-in account, user:{accountId}. An assertion records this account.</Typography>
      {!recoverable && <Typography variant="body2">No recovery action is available for this recorded state. Review its evidence or refresh the saved record.</Typography>}
      {recoverable && <>
        <Button variant="outlined" onClick={() => void recovery.perform({ kind: 'check' })} disabled={recovery.busy || assertion !== null} sx={{ alignSelf: 'flex-start' }}>{checkLabel}</Button>
        {operation.state !== 'submitted' && <Stack spacing={1}>
          <TextField label="Transaction hash" value={transactionHash} onChange={event => setTransactionHash(event.target.value)}
            disabled={recovery.busy || assertion !== null} inputProps={{ maxLength: 68 }} fullWidth
            helperText="Supply a known hash to check it against the saved transfer. A matching pending transaction still needs receipt confirmation." />
          <Button onClick={() => void recovery.perform({ kind: 'resolve', transactionHash: suppliedHash })}
            disabled={recovery.busy || assertion !== null || !/^0x[0-9a-f]{64}$/.test(suppliedHash)} sx={{ alignSelf: 'flex-start' }}>Check this transaction hash</Button>
        </Stack>}
        {canAssertTransfer(detail) && assertion === null && <>
          <Alert severity="warning">The completed search found no match in its checked range. A transaction can still appear later. An operator assertion accepts the risk of paying twice and allows another transfer.</Alert>
          <Button color="warning" onClick={() => void recovery.beginAssertion()} disabled={recovery.busy} sx={{ alignSelf: 'flex-start' }}>Record operator assertion</Button>
        </>}
      </>}
      {assertion?.stage === 'typing' && <Stack spacing={1.5}>
        <Typography variant="subtitle1">Review the duplicate-payment risk</Typography>
        <Typography variant="body2">This records your acceptance of risk. It does not prove that no transaction was sent and does not settle the transfer.</Typography>
        <TransferValue label="Required statement" value={assertion.detail.assertionConfirmation} />
        <TextField label="Type the exact statement" value={assertion.text} onChange={event => recovery.setAssertionText(event.target.value)}
          disabled={recovery.busy} fullWidth inputProps={{ maxLength: 200 }} />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Button color="warning" onClick={recovery.reviewAssertion} disabled={recovery.busy || assertion.text !== assertion.detail.assertionConfirmation}>Review assertion</Button>
          <Button onClick={recovery.cancelAssertion} disabled={recovery.busy}>Cancel assertion</Button>
        </Stack>
      </Stack>}
      {recovery.busy && <Stack spacing={1}>
        <Typography role="status">Waiting for the requested check. Stopping the wait cannot undo an action the manager received.</Typography>
        <Button onClick={recovery.stopWaiting} sx={{ alignSelf: 'flex-start' }}>Stop waiting</Button>
      </Stack>}
    </Stack>
    <Dialog open={assertion?.stage === 'confirming'} onClose={recovery.busy ? undefined : recovery.cancelAssertion} fullWidth maxWidth="sm" aria-labelledby="transfer-assertion-title">
      <DialogTitle id="transfer-assertion-title">Confirm the operator assertion</DialogTitle>
      <DialogContent><Stack spacing={2}>
        <Alert severity="warning">Another transfer may pay twice if the earlier transaction appears later. This assertion does not send a transfer or prove settlement.</Alert>
        {assertion && <TransferValue label="Your statement" value={assertion.detail.assertionConfirmation} />}
        <TransferValue label="Saved node" value={operation.nodeAddress} />
        <TransferValue label="Operation ID" value={operation.id} />
        <Typography variant="body2">The assertion will be recorded for your current account, user:{accountId}.</Typography>
      </Stack></DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap' }}>
        <Button onClick={recovery.cancelAssertion} disabled={recovery.busy}>Cancel assertion</Button>
        <Button color="warning" variant="contained" onClick={recovery.confirmAssertion} disabled={recovery.busy}>Record assertion</Button>
        {recovery.busy && <Button onClick={recovery.stopWaiting}>Stop waiting</Button>}
      </DialogActions>
    </Dialog>
  </Paper>;
}
