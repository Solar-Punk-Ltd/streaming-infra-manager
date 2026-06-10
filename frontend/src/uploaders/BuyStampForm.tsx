import { useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  Link,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { BuyStampInput } from './stampApi';

const DEFAULT_DEPTH = '17';

export function BuyStampForm({
  busy,
  onBuy,
}: {
  busy: boolean;
  onBuy: (input: BuyStampInput) => Promise<void>;
}) {
  const [amount, setAmount] = useState('');
  const [depth, setDepth] = useState(DEFAULT_DEPTH);
  const [label, setLabel] = useState('');
  const [immutable, setImmutable] = useState(false);

  const amountValid = /^[1-9][0-9]*$/.test(amount.trim());
  const depthNum = Number(depth);
  const depthValid =
    Number.isInteger(depthNum) && depthNum >= 17 && depthNum <= 40;
  const canBuy = !busy && amountValid && depthValid;

  const handleBuy = async () => {
    await onBuy({
      amount: amount.trim(),
      depth: Number(depth),
      label: label.trim() || undefined,
      immutable,
    });
    setAmount('');
    setLabel('');
  };

  return (
    <Box>
      <Typography variant="overline" color="text.secondary">
        Buy a stamp
      </Typography>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        alignItems={{ sm: 'flex-start' }}
        sx={{ mt: 1 }}
      >
        <TextField
          label="Amount (PLUR / chunk)"
          size="small"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          error={amount.length > 0 && !amountValid}
          helperText={
            amount.length > 0 && !amountValid
              ? 'positive integer'
              : 'per-chunk amount; higher = longer life'
          }
          slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
        />
        <TextField
          label="Depth"
          size="small"
          value={depth}
          onChange={(e) => setDepth(e.target.value)}
          error={!depthValid}
          helperText={!depthValid ? '17–40' : 'batch size (2^depth)'}
          slotProps={{ htmlInput: { style: { fontFamily: 'monospace' } } }}
        />
        <TextField
          label="Label"
          size="small"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          helperText="optional"
        />
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={immutable}
              onChange={(e) => setImmutable(e.target.checked)}
            />
          }
          label="Immutable"
        />
        <Button
          variant="contained"
          onClick={handleBuy}
          disabled={!canBuy}
          startIcon={busy ? <CircularProgress size={16} /> : null}
        >
          Buy
        </Button>
      </Stack>
      <Typography variant="caption" color="text.secondary">
        A new batch takes a few minutes to become usable. Refresh, then
        <strong> Use</strong> it and <strong>Deploy uploader</strong>.
        Need funds?{' '}
        <Link
          href="https://docs.ethswarm.org/docs/bee/installation/fund-your-node"
          target="_blank"
          rel="noopener"
        >
          Funding guide
        </Link>
        .
      </Typography>
    </Box>
  );
}
