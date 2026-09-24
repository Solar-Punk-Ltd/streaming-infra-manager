import { useState } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import { KeyValueList } from '../components/KeyValueList';
import { BatchSummary } from './BatchSummary';
import type { BeeStamp } from './stampApi';
import { topUpView } from './topUpView';

/**
 * Buys a batch this deployment's node holds more life, paid from the node's
 * wallet. Mounted once per batch it opens for, so an amount typed for one
 * batch never carries over to another.
 */
export function TopUpStampDialog({
  stamp,
  currentPrice,
  walletBzz,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  stamp: BeeStamp;
  currentPrice: string | null;
  /** What the node's wallet holds in PLUR, null where it was not read. */
  walletBzz: string | null;
  busy: boolean;
  /** Why the last attempt failed, shown where the operator is looking. */
  error: string | null;
  onConfirm: (amountPerChunkPlur: string) => void;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState('');
  const view = topUpView({ stamp, amount, currentPrice, walletBzz });

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="top-up-title">
      <DialogTitle id="top-up-title">Top up batch</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <BatchSummary stamp={stamp} />
          <TextField
            label="Amount (PLUR / chunk)"
            size="small"
            autoFocus
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            error={amount.trim() !== '' && !view.amountValid}
            helperText={view.amountHint}
            slotProps={{
              htmlInput: { inputMode: 'numeric', style: { fontFamily: 'monospace' } },
            }}
          />
          <KeyValueList
            entries={[
              { key: 'Adds, at today’s price', value: view.addsLife },
              { key: 'Life after', value: view.lifeAfter },
              { key: 'Costs', value: view.cost },
            ]}
          />
          {view.shortfall && <Alert severity="warning">{view.shortfall}</Alert>}
          {error && <Alert severity="error">{error}</Alert>}
          <Typography variant="caption" color="text.secondary">
            The node pays from its own wallet and sends the transaction itself.
            Closing this dialog after confirming does not stop it.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={busy || !view.canConfirm}
          startIcon={busy ? <CircularProgress size={16} /> : null}
          onClick={() => onConfirm(amount.trim())}
        >
          {view.confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
