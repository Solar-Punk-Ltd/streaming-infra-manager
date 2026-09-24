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

/**
 * Every column the table has, which an empty table's one row spans, and so does
 * each batch's row of actions. The actions have a row of their own because
 * beside seven columns of readings they would sit off the side of a card on a
 * laptop, behind a horizontal scroll.
 */
const COLUMN_COUNT = 7;

interface BatchHandlers {
  onUse: (batchID: string) => void;
  onTopUp: (stamp: BeeStamp) => void;
  onDilute: (stamp: BeeStamp) => void;
}

export function StampTable({
  stamps,
  loading,
  currentStampId,
  busy,
  ...handlers
}: {
  /** The node's batches, or null for "not asked yet / no answer". */
  stamps: BeeStamp[] | null;
  loading: boolean;
  currentStampId: string | null | undefined;
  busy: boolean;
} & BatchHandlers) {
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
              stamps.map((stamp) => (
                <BatchRows
                  key={stamp.batchID}
                  stamp={stamp}
                  isCurrent={
                    currentStampId != null && sameBatchId(currentStampId, stamp.batchID)
                  }
                  busy={busy}
                  {...handlers}
                />
              ))
            )}
          </TableBody>
        </Table>
      </Paper>
    </Box>
  );
}

/** One batch: its readings, and under them what can be done with it. */
function BatchRows({
  stamp,
  isCurrent,
  busy,
  onUse,
  onTopUp,
  onDilute,
}: {
  stamp: BeeStamp;
  isCurrent: boolean;
  busy: boolean;
} & BatchHandlers) {
  const expired = isStampExpired(stamp);
  const fill = bucketFill(stamp);
  const actions = stampRowActions(stamp, busy);

  return (
    <>
      <TableRow sx={{ '& > td': { borderBottom: 0 } }}>
        <TableCell sx={{ fontFamily: 'monospace' }}>
          <Stack direction="row" alignItems="center" spacing={0.5}>
            <span>{shortHex(stamp.batchID)}</span>
            <CopyButton value={stamp.batchID} label="batch id" />
          </Stack>
        </TableCell>
        <TableCell align="right">{stamp.depth}</TableCell>
        <TableCell align="right" sx={{ fontFamily: 'monospace' }}>
          {stamp.amount}
        </TableCell>
        <TableCell>
          <Chip
            size="small"
            variant="outlined"
            color={expired ? 'error' : stamp.usable ? 'success' : 'warning'}
            label={expired ? 'expired' : stamp.usable ? 'usable' : 'pending'}
          />
        </TableCell>
        <TableCell>
          <Chip
            size="small"
            variant="outlined"
            color={stamp.immutableFlag ? 'default' : 'info'}
            label={stamp.immutableFlag ? 'immutable' : 'mutable'}
          />
        </TableCell>
        <TableCell
          title={fill.chunks ? `${fill.chunks} chunks in its fullest bucket` : undefined}
          sx={{ whiteSpace: 'nowrap' }}
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
        <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatTtl(stamp.batchTTL)}</TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={COLUMN_COUNT} sx={{ pt: 0 }}>
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center">
            {isCurrent ? (
              <Chip
                size="small"
                label={expired ? 'in use, expired' : 'in use'}
                color={expired ? 'error' : 'default'}
              />
            ) : (
              <>
                <Button
                  size="small"
                  disabled={!actions.use.enabled}
                  onClick={() => onUse(stamp.batchID)}
                >
                  Use
                </Button>
                {actions.use.note && (
                  <Typography variant="caption" color="error.main">
                    {actions.use.note}
                  </Typography>
                )}
              </>
            )}
            <Button
              size="small"
              disabled={!actions.topUp.enabled}
              onClick={() => onTopUp(stamp)}
            >
              Top up
            </Button>
            <Button
              size="small"
              disabled={!actions.dilute.enabled}
              onClick={() => onDilute(stamp)}
            >
              Dilute
            </Button>
            {actions.dilute.note && (
              <Typography variant="caption" color="text.secondary">
                {actions.dilute.note}
              </Typography>
            )}
          </Stack>
        </TableCell>
      </TableRow>
    </>
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
