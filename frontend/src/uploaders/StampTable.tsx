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
import { CopyButton } from '../CopyButton';
import { formatTtl } from '../format';
import type { BeeStamp } from './stampApi';

export function shortHex(hex: string, lead = 8, tail = 6): string {
  if (hex.length <= lead + tail + 1) return hex;
  return `${hex.slice(0, lead)}…${hex.slice(-tail)}`;
}

export function sameBatch(a: string, b: string): boolean {
  return a.replace(/^0x/, '') === b.replace(/^0x/, '');
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
                  <Typography variant="body2" color="text.disabled">
                    {loading ? 'Loading…' : 'No stamps on this node yet.'}
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              stamps.map((s) => {
                const isCurrent =
                  currentStampId != null && sameBatch(currentStampId, s.batchID);
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
                        color={s.usable ? 'success' : 'warning'}
                        label={s.usable ? 'usable' : 'pending'}
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
                        <Chip size="small" label="in use" />
                      ) : (
                        <Button
                          size="small"
                          disabled={busy || !s.usable}
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
