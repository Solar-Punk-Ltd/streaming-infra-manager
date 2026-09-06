import { Box, Button, Stack, Typography } from '@mui/material';

import {
  type ChequebookHealth,
  type ChequebookSummary,
  chequebookStateReason,
} from '@streaming-infra-manager/common';

import { CopyButton } from '../CopyButton';
import { toneMainColor } from '../components/tone';
import { BZZ_DECIMALS, formatTokenBalance, NO_VALUE } from '../format';

/**
 * What this node can still pay the peers that forward its uploads, and the two
 * ways to change it.
 *
 * A chequebook running dry is invisible everywhere else: the node stays
 * healthy, the uploader keeps accepting segments, and every push waits on a
 * payment that cannot be made. So the balance sits next to the wallet, and the
 * shortfall is spelled out rather than left to a colour.
 *
 * "No chequebook" and "not asked yet" are two different things and read the
 * same way on screen, so the first answer has to arrive before the sentence
 * about an unreachable node can be true.
 */
export function ChequebookRow({
  chequebook,
  health,
  loading,
  busy,
  onFill,
  onWithdraw,
}: {
  chequebook: ChequebookSummary | null;
  health: ChequebookHealth | null;
  /** The node is being asked and has not answered yet, so nothing is known. */
  loading: boolean;
  busy: boolean;
  onFill: () => void;
  onWithdraw: () => void;
}) {
  const available = chequebook?.availableBalance ?? null;
  const shortfall = health ? chequebookStateReason(health) : null;
  const canWithdraw = available != null && available !== '0';

  return (
    <Box>
      <Typography variant="overline" color="text.secondary">
        Chequebook
      </Typography>

      {chequebook === null ? (
        <Typography variant="body2" color="text.secondary">
          {loading
            ? 'Loading…'
            : 'This node did not report a chequebook. Refresh once it is running, or check that it can be reached.'}
        </Typography>
      ) : (
        <>
          <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
            available {formatTokenBalance(available, BZZ_DECIMALS)} BZZ · total{' '}
            {formatTokenBalance(chequebook.totalBalance, BZZ_DECIMALS)} BZZ
          </Typography>

          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography
              variant="body2"
              sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
              color="text.secondary"
            >
              {chequebook.address ?? NO_VALUE}
            </Typography>
            {chequebook.address && (
              <CopyButton value={chequebook.address} label="chequebook address" />
            )}
          </Stack>

          {shortfall && (
            <Typography
              variant="caption"
              component="div"
              sx={(theme) => ({
                mt: 0.5,
                color: toneMainColor(
                  theme,
                  health?.state === 'empty' ? 'err' : 'warn',
                ),
              })}
            >
              {shortfall}
            </Typography>
          )}
        </>
      )}

      <Stack direction="row" spacing={1} sx={{ mt: 1.25 }}>
        <Button
          size="small"
          variant="contained"
          disabled={busy}
          onClick={onFill}
        >
          Fill chequebook
        </Button>
        <Button
          size="small"
          variant="outlined"
          disabled={busy || !canWithdraw}
          onClick={onWithdraw}
        >
          Withdraw
        </Button>
      </Stack>

      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75, display: 'block' }}>
        Paid out to peers so far{' '}
        {formatTokenBalance(chequebook?.totalSent, BZZ_DECIMALS)} BZZ · received{' '}
        {formatTokenBalance(chequebook?.totalReceived, BZZ_DECIMALS)} BZZ
      </Typography>
    </Box>
  );
}
