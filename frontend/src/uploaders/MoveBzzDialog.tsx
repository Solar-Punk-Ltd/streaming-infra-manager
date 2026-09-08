import { useLayoutEffect, useState } from 'react';
import { Alert, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from '@mui/material';
import { bzzToPlur, plurToBzzExact } from '@streaming-infra-manager/common';
import { useSession } from '../app/useSession';
import { BZZ_DECIMALS, formatTokenBalance } from '../format';
import { TransferEvidencePanel, TransferValue } from '../transfers/TransferEvidencePanel';
import { permitsNewTransfer } from '../transfers/transferEvidence';
import { TRANSFER_MESSAGES } from '../transfers/transferMessages';
import { useTransferController } from '../transfers/useTransferController';

export type MoveDirection = 'fill' | 'withdraw';
const COPY = {
  fill: { title: 'Fill chequebook', source: 'Wallet balance', route: 'Wallet to chequebook' },
  withdraw: { title: 'Withdraw from chequebook', source: 'Available in the chequebook', route: 'Chequebook to wallet' },
} as const;

/** The saved request and transaction evidence remain visible until the operator closes the dialog. */
export function MoveBzzDialog({ open, direction, profileName, profileInstanceId, sourcePlur, floorBzz, onClose }: {
  open: boolean;
  direction: MoveDirection;
  profileName: string;
  profileInstanceId: string;
  sourcePlur: bigint | null;
  floorBzz: string;
  onClose: () => void;
}) {
  const session = useSession();
  const accountId = session.state.status === 'signedIn' ? session.state.id : null;
  const { controller, state } = useTransferController(open, accountId, profileName, profileInstanceId);
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<'entry' | 'review' | 'retry'>('entry');
  const [newFrom, setNewFrom] = useState<string | null>(null);
  useLayoutEffect(() => {
    setAmount(''); setStep('entry'); setNewFrom(null);
  }, [open, direction, accountId, profileName, profileInstanceId]);

  const copy = COPY[direction];
  const amountPlur = bzzToPlur(amount.replace(',', '.'));
  const overSource = amountPlur !== null && sourcePlur !== null && amountPlur > sourcePlur;
  const amountValid = amountPlur !== null && amountPlur > 0n && !overSource;
  const amountHelp = overSource ? `That is more than the ${copy.source.toLowerCase()}.`
    : amount.includes(',') ? 'Use a period for decimals, for example 0.5.' : 'A BZZ amount above zero, with at most 16 decimal places.';
  const busy = state.phase === 'loading' || state.phase === 'sending';
  const editingNew = state.intent === null || newFrom === state.intent.requestId;
  const signedIn = accountId !== null && state.phase !== 'signed_out';
  const canEdit = signedIn && editingNew && !busy && state.issue !== 'storage_unavailable';
  const canNew = state.intent !== null && state.detail !== null && permitsNewTransfer(state.detail) && !busy;
  const canRetry = state.intent !== null && state.issue === 'lookup_missing' && !busy && state.blockingReason !== 'identity_conflict' &&
    state.intent.accountId === accountId && state.intent.profileName === profileName && state.intent.profileInstanceId === profileInstanceId;
  const intent = state.intent;
  const blockingContext = state.blockingReason === 'identity_conflict' ? 'identity_conflict' : state.issue === 'busy' ? 'busy' : 'previous_busy';
  const title = intent && !editingNew ? (intent.direction === 'deposit' ? 'Saved fill to chequebook' : 'Saved withdrawal from chequebook') : copy.title;

  const confirm = () => {
    if (!canEdit || !amountValid || amountPlur === null) return;
    setStep('entry');
    const expected = newFrom;
    setNewFrom(null);
    void controller.confirmNew({ direction: direction === 'fill' ? 'deposit' : 'withdraw', amountPlur: amountPlur.toString() }, expected);
  };
  const close = () => { controller.cancel(); onClose(); };

  return <Dialog open={open} onClose={close} maxWidth="sm" fullWidth aria-labelledby="transfer-dialog-title">
    <DialogTitle id="transfer-dialog-title">{title}</DialogTitle>
    <DialogContent>
      <Stack spacing={2} sx={{ pt: 0.5 }}>
        {!signedIn ? <Alert severity="warning">Sign in to continue. Any saved transfer stays in this browser.</Alert> : <>
          {state.issue && <Alert severity={state.issue === 'link_unavailable' ? 'info' : 'warning'}>{TRANSFER_MESSAGES[state.issue]}</Alert>}
          {busy && <Stack direction="row" spacing={1} alignItems="center" role="status">
            <CircularProgress size={18} /><Typography variant="body2">{state.phase === 'sending' ? 'Sending the saved request' : 'Reading saved transfer status'}</Typography>
          </Stack>}
          {intent && !editingNew && <>
            <TransferValue label="Saved amount" value={`${plurToBzzExact(BigInt(intent.amountPlur))} BZZ`} />
            <TransferValue label="Saved direction" value={intent.direction === 'deposit' ? COPY.fill.route : COPY.withdraw.route} />
            <TransferValue label="Saved deployment" value={intent.profileName} />
            <TransferValue label="Request ID" value={intent.requestId} copy />
            {state.detail ? <TransferEvidencePanel detail={state.detail} /> : <Typography variant="body2" color="text.secondary">
              The manager has not returned a verified record for this request. Its transaction outcome is unknown.
            </Typography>}
            {state.blocking && <TransferEvidencePanel detail={state.blocking} context={blockingContext} />}
            {step === 'retry' && <Alert severity="warning">Send the same request again only to recover this exact saved intent. It keeps the same request ID and amount. The manager decides whether the request was already recorded.</Alert>}
          </>}
          {editingNew && step !== 'review' && <>
            <TextField label="Amount (BZZ)" size="small" autoFocus value={amount} disabled={!canEdit}
              onChange={event => setAmount(event.target.value)} error={amount.trim() !== '' && !amountValid} helperText={amountHelp}
              slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
            <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
              <Typography variant="body2" color="text.secondary">{copy.source}: {formatTokenBalance(sourcePlur?.toString() ?? null, BZZ_DECIMALS)} BZZ</Typography>
              {sourcePlur !== null && sourcePlur > 0n && <Button size="small" disabled={!canEdit} onClick={() => setAmount(plurToBzzExact(sourcePlur))}>Use all</Button>}
            </Stack>
            <Typography variant="body2">{copy.route}. This creates an on-chain transaction and costs gas. Review the amount before confirming.</Typography>
            {direction === 'fill' && <Typography variant="caption" color="text.secondary">Below {floorBzz} BZZ this manager will not start an uploader for this node.</Typography>}
          </>}
          {editingNew && step === 'review' && amountPlur !== null && <>
            <Typography variant="h6">{plurToBzzExact(amountPlur)} BZZ</Typography>
            <TransferValue label="Direction" value={copy.route} />
            <TransferValue label="Deployment" value={profileName} />
            <Typography variant="body2">Confirming first saves a permanent request ID in this browser, then submits that exact request. Closing this dialog cannot cancel a transaction that has been sent.</Typography>
          </>}
        </>}
      </Stack>
    </DialogContent>
    <DialogActions sx={{ flexWrap: 'wrap', gap: 0.5, px: 3, pb: 2 }}>
      <Button onClick={close}>Close</Button>
      {signedIn && editingNew && step !== 'review' && <Button variant="contained" disabled={!canEdit || !amountValid} onClick={() => setStep('review')}>Review transfer</Button>}
      {signedIn && editingNew && step === 'review' && <>
        <Button disabled={busy} onClick={() => setStep('entry')}>Edit amount</Button>
        <Button variant="contained" disabled={!canEdit || !amountValid} onClick={confirm}>Confirm transfer</Button>
      </>}
      {signedIn && intent && !editingNew && <>
        <Button disabled={busy} onClick={() => void controller.restore()}>Refresh saved status</Button>
        {canRetry && step !== 'retry' && <Button onClick={() => setStep('retry')}>Retry this saved request</Button>}
        {canRetry && step === 'retry' && <Button variant="contained" onClick={() => { setStep('entry'); void controller.retryExact(); }}>Send the same request again</Button>}
        {canNew && <Button variant="contained" onClick={() => { setNewFrom(intent.requestId); setAmount(''); setStep('entry'); }}>New transfer</Button>}
      </>}
    </DialogActions>
  </Dialog>;
}
