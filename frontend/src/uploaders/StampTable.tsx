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
import { formatTtl, shortHex } from '../format';
import { bucketFill, type BucketFillWarning } from './bucketFill';
import type { BeeStamp } from './stampApi';
import { stampRowActions } from './stampRowActions';

const FILL_COLOUR: Record<BucketFillWarning, string> = {
  full: 'error.main',
  'nearly-full': 'warning.main',
};

/** Every column the table has, which an empty table's one row spans. */
const COLUMN_COUNT = 8;

export function StampTable({
  stamps,
  loading,
  currentStampId,
  busy,
  onUse,
}: {
  /** The node's batches, or null for "not asked yet / no answer". */
  stamps: BeeStamp[] | null;
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
      <Paper variant="outlined" sx={{ mt: 1, overflowX: 'auto' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Batch ID</TableCell>
              <TableCell align="right">Depth</TableCell>
              <TableCell align="right">Amount</TableCell>
              <TableCell>Usable</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Used</TableCell>
              <TableCell>TTL</TableCell>
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {stamps === null || stamps.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLUMN_COUNT}>
                  <EmptyState
                    stamps={stamps}
                    loading={loading}
                    currentStampId={currentStampId}
                  />
                </TableCell>
              </TableRow>
            ) : (
              stamps.map((s) => {
                const isCurrent =
                  currentStampId != null && sameBatchId(currentStampId, s.batchID);
                const expired = isStampExpired(s);
                const fill = bucketFill(s);
                const actions = stampRowActions(s, busy);
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
                    <TableCell
                      title={
                        fill.chunks
                          ? `${fill.chunks} chunks in its fullest bucket`
                          : undefined
                      }
                    >
                      <Typography
                        variant="body2"
                        color={fill.warning ? FILL_COLOUR[fill.warning] : undefined}
                      >
                        {fill.percent}
                      </Typography>
                      {fill.chunks && (
                        <Typography variant="caption" color="text.secondary">
                          {fill.chunks}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>{formatTtl(s.batchTTL)}</TableCell>
                    <TableCell align="right">
                      {isCurrent ? (
                        <Chip
                          size="small"
                          label={expired ? 'in use, expired' : 'in use'}
                          color={expired ? 'error' : 'default'}
                        />
                      ) : (
                        <Stack alignItems="flex-end">
                          <Button
                            size="small"
                            disabled={!actions.use.enabled}
                            onClick={() => onUse(s.batchID)}
                          >
                            Use
                          </Button>
                          {actions.use.note && (
                            <Typography variant="caption" color="error.main">
                              {actions.use.note}
                            </Typography>
                          )}
                        </Stack>
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

/**
 * Why the table is empty, which is four different situations, not one.
 *
 * Only the last of them means the recorded batch is gone. Reporting the others
 * that way turns a node that is slow, or briefly unreachable, into a node with a
 * dead batch, and puts a red claim directly under the "bee node unreachable"
 * banner that contradicts it.
 */
function EmptyState({
  stamps,
  loading,
  currentStampId,
}: {
  stamps: BeeStamp[] | null;
  loading: boolean;
  currentStampId: string | null | undefined;
}) {
  if (stamps === null) {
    return (
      <Typography variant="body2" color="text.disabled">
        {loading
          ? 'Loading…'
          : 'Could not read this node’s batches, so nothing here is known either way. Press Refresh once the node is reachable.'}
      </Typography>
    );
  }

  // The node answered, and holds nothing. With an id still on the profile that is
  // the orphan case: the batch expired and was dropped.
  if (currentStampId) {
    return (
      <Typography variant="body2" color="error.main">
        This node holds no batches, yet {shortHex(currentStampId)} is still
        recorded on the profile. Buy a new one below, and it is set here once
        it is usable.
      </Typography>
    );
  }

  return (
    <Typography variant="body2" color="text.disabled">
      No stamps on this node yet.
    </Typography>
  );
}
