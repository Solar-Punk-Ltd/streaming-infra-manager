import {
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { isStampExpired, sameBatchId } from '@streaming-infra-manager/common';

import { CopyButton } from '../CopyButton';
import { formatTtl } from '../format';
import type { BeeStamp } from './stampApi';

export function shortHex(hex: string, lead = 8, tail = 6): string {
  if (hex.length <= lead + tail + 1) return hex;
  return `${hex.slice(0, lead)}…${hex.slice(-tail)}`;
}

export function StampTable({
  stamps,
  loading,
  currentStampId,
  busy,
  onUse,
}: {
  stamps: BeeStamp[];
  loading: boolean;
  currentStampId: string | null | undefined;
  busy: boolean;
  onUse: (batchID: string) => void;
}) {
  return (
    <Box>
      <Typography variant="overline" color="text.secondary">
        Postage stamps
      </Typography>
      <Paper variant="outlined" sx={{ mt: 1 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Batch ID</TableCell>
              <TableCell align="right">Depth</TableCell>
              <TableCell align="right">Amount</TableCell>
              <TableCell>Usable</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>TTL</TableCell>
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {stamps.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7}>
                  <Typography
                    variant="body2"
                    color={
                      !loading && currentStampId
                        ? 'error.main'
                        : 'text.disabled'
                    }
                  >
                    {loading
                      ? 'Loading…'
                      : currentStampId
                        ? `This node holds no batches, yet ${shortHex(currentStampId)} is still recorded on the profile. Buy a new one below and set it with Use.`
                        : 'No stamps on this node yet.'}
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              stamps.map((s) => {
                const isCurrent =
                  currentStampId != null && sameBatchId(currentStampId, s.batchID);
                const expired = isStampExpired(s);
                return (
                  <TableRow key={s.batchID}>
                    <TableCell sx={{ fontFamily: 'monospace' }}>
                      <Stack
                        direction="row"
                        alignItems="center"
                        spacing={0.5}
                      >
                        <span>{shortHex(s.batchID)}</span>
                        <CopyButton value={s.batchID} label="batch id" />
                      </Stack>
                    </TableCell>
                    <TableCell align="right">{s.depth}</TableCell>
                    <TableCell
                      align="right"
                      sx={{ fontFamily: 'monospace' }}
                    >
                      {s.amount}
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        variant="outlined"
                        color={
                          expired ? 'error' : s.usable ? 'success' : 'warning'
                        }
                        label={
                          expired ? 'expired' : s.usable ? 'usable' : 'pending'
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        variant="outlined"
                        color={s.immutableFlag ? 'default' : 'info'}
                        label={s.immutableFlag ? 'immutable' : 'mutable'}
                      />
                    </TableCell>
                    <TableCell>{formatTtl(s.batchTTL)}</TableCell>
                    <TableCell align="right">
                      {isCurrent ? (
                        <Chip
                          size="small"
                          label={expired ? 'in use — expired' : 'in use'}
                          color={expired ? 'error' : 'default'}
                        />
                      ) : (
                        <Button
                          size="small"
                          disabled={busy || !s.usable || expired}
                          onClick={() => onUse(s.batchID)}
                        >
                          Use
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Paper>
    </Box>
  );
}
