import { Box, Stack, Typography } from '@mui/material';

import { MONO_STACK } from '../app/theme';
import { shortHex } from '../format';
import { batchSummaryLine } from './batchSummaryLine';
import type { BeeStamp } from './stampApi';

/** The batch a change dialog is about, named before anything is paid for. */
export function BatchSummary({ stamp }: { stamp: BeeStamp }) {
  return (
    <Stack spacing={0.25}>
      <Typography variant="body2">
        Batch{' '}
        <Box component="span" sx={{ fontFamily: MONO_STACK }}>
          {shortHex(stamp.batchID)}
        </Box>
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {batchSummaryLine(stamp)}
      </Typography>
    </Stack>
  );
}
