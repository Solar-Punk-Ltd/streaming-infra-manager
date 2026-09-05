import { Box, Stack, Typography } from '@mui/material';
import { CopyButton } from '../CopyButton';
import {
  BZZ_DECIMALS,
  formatTokenBalance,
  NO_VALUE,
  XDAI_DECIMALS,
} from '../format';
import type { BeeAddress, BeeWallet } from './stampApi';

export function NodeFunding({
  address,
  wallet,
}: {
  address: BeeAddress | null;
  wallet: BeeWallet | null;
}) {
  return (
    <>
      <Box>
        <Typography variant="overline" color="text.secondary">
          Node funding address (Gnosis Chain)
        </Typography>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography
            variant="body2"
            sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
          >
            {address?.ethereum ?? NO_VALUE}
          </Typography>
          {address?.ethereum && (
            <CopyButton value={address.ethereum} label="address" />
          )}
        </Stack>
        <Typography variant="caption" color="text.secondary">
          Send xDAI (gas) and BZZ (storage) here, then buy a stamp.
        </Typography>
      </Box>

      <Stack direction="row" spacing={3}>
        <Box>
          <Typography variant="overline" color="text.secondary">
            xDAI
          </Typography>
          <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
            {formatTokenBalance(wallet?.nativeTokenBalance, XDAI_DECIMALS)}
          </Typography>
        </Box>
        <Box>
          <Typography variant="overline" color="text.secondary">
            BZZ
          </Typography>
          <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
            {formatTokenBalance(wallet?.bzzBalance, BZZ_DECIMALS)}
          </Typography>
        </Box>
      </Stack>
    </>
  );
}
