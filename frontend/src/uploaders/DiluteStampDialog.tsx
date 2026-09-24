import { useState } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { MAX_STAMP_DEPTH } from '@streaming-infra-manager/common';

import { KeyValueList } from '../components/KeyValueList';
import { BatchSummary } from './BatchSummary';
import { DILUTE_COSTS, diluteView, firstDiluteDepth } from './diluteView';
import type { BeeStamp } from './stampApi';

/**
 * Buys a batch this deployment's node holds more room by raising its depth,
 * for half its life every step. Mounted once per batch it opens for, so a depth
 * typed for one batch never carries over to another.
 */
export function DiluteStampDialog({
  stamp,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  stamp: BeeStamp;
  busy: boolean;
  /** Why the last attempt failed, shown where the operator is looking. */
  error: string | null;
  onConfirm: (depth: number) => void;
  onClose: () => void;
}) {
  const [depth, setDepth] = useState(String(firstDiluteDepth(stamp)));
  const view = diluteView({ stamp, depth });

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="dilute-title">
      <DialogTitle id="dilute-title">Dilute batch</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <BatchSummary stamp={stamp} />
          <TextField
            label="New depth"
            size="small"
            type="number"
            autoFocus
            value={depth}
            onChange={(event) => setDepth(event.target.value)}
            error={!view.depthValid}
            helperText={view.depthHint}
            slotProps={{
              htmlInput: {
                min: firstDiluteDepth(stamp),
                max: MAX_STAMP_DEPTH,
                style: { fontFamily: 'monospace' },
              },
            }}
          />
          <KeyValueList
            entries={[
              { key: 'Holds after', value: view.holdsAfter },
              { key: 'Full after', value: view.fullAfter },
              { key: 'Life after', value: view.lifeAfter },
              { key: 'Costs', value: DILUTE_COSTS },
            ]}
          />
          {view.shortLife && <Alert severity="warning">{view.shortLife}</Alert>}
          {error && <Alert severity="error">{error}</Alert>}
          <Typography variant="caption" color="text.secondary">
            The node sends the transaction itself, and the batch keeps its id,
            so nothing that names it has to change. Closing this dialog after
            confirming does not stop it.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={busy || !view.canConfirm}
          startIcon={busy ? <CircularProgress size={16} /> : null}
          onClick={() => onConfirm(Number(depth.trim()))}
        >
          {view.confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
