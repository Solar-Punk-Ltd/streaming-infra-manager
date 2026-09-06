import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  type AlertColor,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Link,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import {
  type BeeTransaction,
  bzzToPlur,
  getErrorMessage,
  plurToBzzExact,
  type TransferDirection,
  type TransferExpectation,
  type TransferOutcome,
} from '@streaming-infra-manager/common';

import { CopyButton } from '../CopyButton';
import { BZZ_DECIMALS, formatTokenBalance, shortHex } from '../format';

/** Which way the BZZ moves between a node's two pots. */
export type MoveDirection = 'fill' | 'withdraw';

/** Filling the chequebook is a deposit, which is what the rule calls it. */
const TRANSFER_DIRECTION: Record<MoveDirection, TransferDirection> = {
  fill: 'deposit',
  withdraw: 'withdraw',
};

interface DirectionCopy {
  title: string;
  confirmLabel: string;
  sourceLabel: string;
  /** What confirming actually does, in the words it does it in. */
  explanation: string;
}

const COPY: Record<MoveDirection, DirectionCopy> = {
  fill: {
    title: 'Fill chequebook',
    confirmLabel: 'Fill chequebook',
    sourceLabel: 'Wallet balance',
    explanation:
      "Moves BZZ from this node's wallet into its chequebook. This is an on-chain transaction on Gnosis Chain, it costs a little xDAI in gas, and it cannot be undone from here.",
  },
  withdraw: {
    title: 'Withdraw from chequebook',
    confirmLabel: 'Withdraw',
    sourceLabel: 'Available in the chequebook',
    explanation:
      "Moves BZZ from this node's chequebook back into its wallet. This is an on-chain transaction on Gnosis Chain, it costs a little xDAI in gas, and it cannot be undone from here.",
  },
};

const AMOUNT_HELP =
  'A BZZ amount above zero, with at most 16 decimal places.';

/**
 * What to say once a comma has been read as a decimal point, so the number that
 * ends up submitted is not a surprise.
 */
const DECIMAL_COMMA_HELP = 'Use a period for decimals, for example 0.5.';

type Phase =
  /** Typing an amount, nothing submitted. */
  | 'entering'
  /** The call is in flight, the node has not answered with a hash yet. */
  | 'sending'
  /** Submitted, and the chequebook is being watched for it. */
  | 'waiting'
  /** Submitted, and the last look said the total has not moved yet. */
  | 'pending'
  /** Submitted, and the node gave no reading to judge it by. */
  | 'unknown'
  /** Looking once more, after the wait was given up on. */
  | 'checking';

/** The transfer on its way, and what a later reading has to show for it. */
interface SubmittedTransfer {
  transactionHash: string;
  expectation: TransferExpectation;
}

/** Every phase in which there is a submitted transaction to report on. */
type StatusPhase = Exclude<Phase, 'entering' | 'sending'>;

const TRANSFER_STATUS: Record<
  StatusPhase,
  { severity: AlertColor; spinner: boolean; text: string }
> = {
  waiting: {
    severity: 'info',
    spinner: true,
    text: 'Waiting for it to mine. A block on Gnosis Chain takes about five seconds. The transaction cannot be cancelled from here, and this dialog closes on its own once the chequebook total moves.',
  },
  pending: {
    severity: 'warning',
    spinner: false,
    text: 'The chequebook total has not moved yet. It may still be mining, so check again in a moment.',
  },
  unknown: {
    severity: 'warning',
    spinner: false,
    text: 'The node stopped answering, so it is not known yet whether it settled. Check again in a moment.',
  },
  checking: {
    severity: 'info',
    spinner: true,
    text: 'Reading the chequebook again.',
  },
};

/**
 * What became of the submitted transaction, under the hash to look it up by.
 *
 * The hash is the only thing an operator keeps if the node goes quiet, so it is
 * on screen from the moment bee answers, shortened to be read and whole on the
 * clipboard to be pasted into a block explorer.
 */
function TransferStatus({
  phase,
  transactionHash,
}: {
  phase: StatusPhase;
  transactionHash: string;
}) {
  const status = TRANSFER_STATUS[phase];
  return (
    <Alert
      severity={status.severity}
      icon={status.spinner ? <CircularProgress size={18} /> : undefined}
    >
      <Stack direction="row" alignItems="center" spacing={0.5}>
        <span>
          Submitted as <code>{shortHex(transactionHash)}</code>
        </span>
        <CopyButton value={transactionHash} label="transaction hash" />
      </Stack>
      {status.text}
    </Alert>
  );
}

/**
 * Moving BZZ between a node's wallet and its chequebook, either way.
 *
 * One component for both directions because the two differ only in wording and
 * in which balance the amount is checked against: the confirmation, the "use
 * all" that leaves nothing behind, and the wait for the chain are the same
 * problem twice.
 *
 * Bee answers the call as soon as the transaction is submitted rather than once
 * it is mined, so confirming is not the end of it. The dialog then watches the
 * chequebook total and closes when it has moved by the amount, which is the
 * only thing that proves the move happened.
 *
 * The hash bee answered with is on screen for as long as that transfer is what
 * the dialog is about, so a slow one, or one the node stopped being able to
 * report on, can still be looked up on a block explorer. A node that gives no
 * reading is said to give no reading, never taken as a transfer that landed.
 *
 * Nothing dismisses the dialog while a transfer is in flight, and every step
 * after an `await` checks that it still belongs to the attempt on screen. An
 * abandoned continuation of an earlier attempt would otherwise land in a later
 * one, closing a dialog that is showing a different amount or a different
 * direction.
 *
 * Once the wait has been given up on, the only thing the button does is look
 * again. A transfer that is merely slow is already on its way, and a second
 * submit of the same amount would move the money twice.
 */
export function MoveBzzDialog({
  open,
  direction,
  sourcePlur,
  floorBzz,
  onMove,
  onWait,
  onCheck,
  onClose,
}: {
  open: boolean;
  direction: MoveDirection;
  /** What the move draws from, or null when the node did not report it. */
  sourcePlur: bigint | null;
  /** The chequebook floor the manager's deploy gate uses. */
  floorBzz: string;
  /** Submit the transfer, answering with the transaction bee accepted. */
  onMove: (amountPlur: bigint) => Promise<BeeTransaction>;
  onWait: (
    expectation: TransferExpectation,
    signal: AbortSignal,
  ) => Promise<TransferOutcome>;
  /** Read the chequebook once more, answering whether the transfer landed. */
  onCheck: (expectation: TransferExpectation) => Promise<TransferOutcome>;
  onClose: () => void;
}) {
  const copy = COPY[direction];
  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState<Phase>('entering');
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<SubmittedTransfer | null>(null);

  // Which attempt the continuations after each await belong to, and how the
  // wait for the chain is called off when they no longer belong to any.
  const attempt = useRef(0);
  const wait = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    attempt.current += 1;
    wait.current?.abort();
    wait.current = null;
    setAmount('');
    setPhase('entering');
    setError(null);
    setSubmitted(null);
  }, [open, direction]);

  // The page can be navigated away from mid transfer, and a poll that outlives
  // the dialog keeps asking the manager for a node nobody is looking at.
  useEffect(
    () => () => {
      attempt.current += 1;
      wait.current?.abort();
      wait.current = null;
    },
    [],
  );

  // Most of Europe types 0,5 for half a BZZ, and refusing it under "at most 16
  // decimal places" names neither the problem nor the fix.
  const usedComma = amount.includes(',');
  const amountPlur = bzzToPlur(amount.replace(',', '.'));
  const overSource =
    amountPlur !== null && sourcePlur !== null && amountPlur > sourcePlur;
  const amountHelp = usedComma ? DECIMAL_COMMA_HELP : AMOUNT_HELP;
  const amountProblem =
    amount.trim() === ''
      ? null
      : amountPlur === null
        ? amountHelp
        : overSource
          ? `That is more than the ${copy.sourceLabel.toLowerCase()}.`
          : null;

  const busy = phase === 'sending' || phase === 'waiting';
  const unsettled =
    phase === 'pending' || phase === 'unknown' || phase === 'checking';
  const canConfirm = amountPlur !== null && !overSource && !busy && !unsettled;

  // A new amount is a new intention, so the transfer that was given up on stops
  // being what the button acts on, and a check still in flight cannot put the
  // dialog back into the phase it was typed out of.
  const editAmount = (next: string) => {
    attempt.current += 1;
    setAmount(next);
    setPhase('entering');
    setSubmitted(null);
  };

  const confirm = async () => {
    if (amountPlur === null) return;
    const mine = ++attempt.current;
    const expectation: TransferExpectation = {
      direction: TRANSFER_DIRECTION[direction],
      amountPlur,
    };
    setError(null);
    setPhase('sending');

    let transaction: BeeTransaction;
    try {
      transaction = await onMove(amountPlur);
    } catch (caught) {
      if (mine !== attempt.current) return;
      setError(getErrorMessage(caught));
      setPhase('entering');
      return;
    }
    if (mine !== attempt.current) return;

    setSubmitted({ transactionHash: transaction.transactionHash, expectation });
    setPhase('waiting');
    const controller = new AbortController();
    wait.current = controller;
    const outcome = await onWait(expectation, controller.signal);
    if (mine !== attempt.current) {
      controller.abort();
      return;
    }
    wait.current = null;

    if (outcome === 'settled') {
      onClose();
      return;
    }
    setPhase(outcome);
  };

  const check = async () => {
    if (!submitted) return;
    const mine = attempt.current;
    setError(null);
    setPhase('checking');

    const outcome = await onCheck(submitted.expectation);
    if (mine !== attempt.current) return;
    if (outcome === 'settled') {
      onClose();
      return;
    }
    setPhase(outcome);
  };

  return (
    <Dialog
      open={open}
      onClose={(_event, reason) => {
        if (busy && reason === 'backdropClick') return;
        onClose();
      }}
      disableEscapeKeyDown={busy}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle>{copy.title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          {error && <Alert severity="error">{error}</Alert>}

          <Stack direction="row" spacing={2} alignItems="flex-start">
            <TextField
              label="Amount (BZZ)"
              size="small"
              autoFocus
              value={amount}
              disabled={busy}
              onChange={(event) => editAmount(event.target.value)}
              error={amountProblem !== null}
              helperText={amountProblem ?? amountHelp}
              slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
              sx={{ flexGrow: 1 }}
            />
            <Stack sx={{ pt: 0.5 }}>
              <Typography variant="caption" color="text.secondary">
                {copy.sourceLabel}
              </Typography>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                {formatTokenBalance(
                  sourcePlur === null ? null : sourcePlur.toString(),
                  BZZ_DECIMALS,
                )}{' '}
                BZZ
              </Typography>
              {sourcePlur !== null && sourcePlur > 0n && !busy && (
                <Link
                  component="button"
                  type="button"
                  variant="caption"
                  underline="hover"
                  sx={{ alignSelf: 'flex-start' }}
                  onClick={() => editAmount(plurToBzzExact(sourcePlur))}
                >
                  Use all
                </Link>
              )}
            </Stack>
          </Stack>

          <Typography variant="body2" color="text.secondary">
            {copy.explanation}
          </Typography>

          {direction === 'fill' && (
            <Typography variant="caption" color="text.secondary">
              Below {floorBzz} BZZ this manager will not start an uploader for
              this node.
            </Typography>
          )}

          {submitted && phase !== 'entering' && phase !== 'sending' && (
            <TransferStatus
              phase={phase}
              transactionHash={submitted.transactionHash}
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {unsettled ? 'Close' : 'Cancel'}
        </Button>
        {unsettled ? (
          <Button
            variant="contained"
            disabled={phase === 'checking'}
            startIcon={
              phase === 'checking' ? <CircularProgress size={16} /> : null
            }
            onClick={() => void check()}
          >
            Check again
          </Button>
        ) : (
          <Button
            variant="contained"
            disabled={!canConfirm}
            startIcon={busy ? <CircularProgress size={16} /> : null}
            onClick={() => void confirm()}
          >
            {copy.confirmLabel}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
