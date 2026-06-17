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
import { stampCostPlur, stampTtlSeconds } from '@streaming-infra-manager/common';

import type { BuyStampInput } from './stampApi';
import { formatTokenBalance, formatTtl } from '../format';

const DEFAULT_DEPTH = '17';
const BZZ_DECIMALS = 16;

export function BuyStampForm({
  busy,
  onBuy,
  currentPrice,
}: {
  busy: boolean;
  onBuy: (input: BuyStampInput) => Promise<void>;
  currentPrice: string | null;
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

  const ttlSeconds = stampTtlSeconds(amount, currentPrice);
  const costPlur = depthValid ? stampCostPlur(amount, depthNum) : null;
  const costBzz =
    costPlur != null ? formatTokenBalance(costPlur, BZZ_DECIMALS) : null;

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
      <Stack
        direction="row"
        spacing={3}
        sx={{ mt: 1 }}
        divider={<Box sx={{ borderLeft: 1, borderColor: 'divider' }} />}
      >
        <Typography variant="body2" color="text.secondary">
          Estimated life:{' '}
          <Box component="span" sx={{ color: 'text.primary', fontWeight: 500 }}>
            {amountValid ? formatTtl(ttlSeconds) : '—'}
          </Box>
          {amountValid && ttlSeconds == null && currentPrice == null
            ? ' (price unavailable)'
            : ''}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Cost:{' '}
          <Box component="span" sx={{ color: 'text.primary', fontWeight: 500 }}>
            {costBzz != null ? `${costBzz} BZZ` : '—'}
          </Box>
        </Typography>
      </Stack>
      <Typography variant="caption" color="text.secondary">
        A new batch takes a few minutes to become usable. Refresh, then
        <strong> Use</strong> it and <strong>Deploy uploader</strong>. Need
        funds?{' '}
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
