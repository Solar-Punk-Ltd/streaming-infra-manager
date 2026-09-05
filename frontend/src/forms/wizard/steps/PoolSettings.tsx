import {
  Box,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';

import {
  DEFAULT_ABR_LADDER,
  suggestedRungDepth,
} from '@streaming-infra-manager/common';

import { MONO_STACK } from '../../../app/theme';
import type { WizardStepProps } from '../wizardState';

const AFTERWARDS =
  'After creating it: fund each node with xDAI and BZZ, buy each its stamp (the buy form starts at the suggested depth), then copy the pool string from the pool page into an ABR uploader.';

export function PoolSettings({ state }: WizardStepProps) {
  const poolName = state.name || '<pool>';

  return (
    <Stack spacing={2}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Member</TableCell>
            <TableCell>Quality</TableCell>
            <TableCell>Bitrate</TableCell>
            <TableCell>Suggested stamp depth</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {DEFAULT_ABR_LADDER.map((rung, index) => (
            <TableRow key={rung.name}>
              <TableCell sx={{ fontFamily: MONO_STACK }}>
                {poolName}-{rung.name}
                {index === 0 && (
                  <Typography component="span" variant="caption" color="text.secondary">
                    {' '}
                    coordinator
                  </Typography>
                )}
              </TableCell>
              <TableCell>
                {rung.width}×{rung.height}
              </TableCell>
              <TableCell>{rung.kbps} kbps</TableCell>
              <TableCell>{suggestedRungDepth(rung.name)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Box
        sx={{
          border: 1,
          borderColor: 'divider',
          borderRadius: 2,
          p: 1.5,
          bgcolor: 'action.hover',
        }}
      >
        <Typography variant="body2">{AFTERWARDS}</Typography>
      </Box>
    </Stack>
  );
}
