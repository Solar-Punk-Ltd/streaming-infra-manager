import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import {
  attemptReleaseProblem,
  describeAttemptHold,
  getErrorMessage,
  type DeployAttemptView,
} from '@streaming-infra-manager/common';

import { MONO_STACK } from '../app/theme';
import { formatDateTime } from '../format';

import { releaseAttempt } from './attemptsApi';

const CHECK_THE_HOST =
  'Release it only after checking on the host that nothing of this attempt is still running: no docker compose process for the deployment, and no image build in progress. The next deploy builds as soon as the attempt is released, and a build still running beside it is what the guard exists to prevent.';

/**
 * Ends an attempt by hand. The job id has to be typed back, the same rule the
 * manager applies to the request, because a click is not a person who
 * checked the host.
 */
export function ReleaseAttemptDialog({
  attempt,
  onClose,
  onReleased,
}: {
  attempt: DeployAttemptView | null;
  onClose: () => void;
  onReleased: (released: DeployAttemptView) => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh field per attempt: what was typed for one must not release another.
  useEffect(() => {
    setTyped('');
    setError(null);
    setBusy(false);
  }, [attempt?.id]);

  const problem = attempt ? attemptReleaseProblem(typed, attempt) : null;

  const submit = async () => {
    if (!attempt || problem) return;
    setBusy(true);
    setError(null);
    try {
      const released = await releaseAttempt(attempt.id, typed.trim());
      onReleased(released);
      onClose();
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={attempt !== null}
      onClose={busy ? undefined : onClose}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>Release attempt {attempt?.jobId}?</DialogTitle>
      <DialogContent>
        {attempt && (
          <Stack spacing={1.5}>
            <Typography variant="body2">
              {describeAttemptHold(attempt)} Started{' '}
              {formatDateTime(attempt.startedAt)}, touching{' '}
              {attempt.services.join(', ')}.
            </Typography>
            {attempt.reason && (
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ fontFamily: MONO_STACK, fontSize: 12, whiteSpace: 'pre-wrap' }}
              >
                {attempt.reason}
              </Typography>
            )}
            <Typography variant="body2">{CHECK_THE_HOST}</Typography>
            <TextField
              label="Job id"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              error={typed !== '' && problem !== null}
              helperText={
                typed === ''
                  ? `Type ${attempt.jobId} to confirm you checked.`
                  : (problem ?? 'That is this attempt.')
              }
              disabled={busy}
              autoComplete="off"
              autoFocus
              fullWidth
              slotProps={{
                htmlInput: {
                  autoCapitalize: 'none',
                  autoCorrect: 'off',
                  spellCheck: false,
                  style: { fontFamily: MONO_STACK },
                },
              }}
            />
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color="error"
          disabled={busy || problem !== null}
          onClick={() => void submit()}
        >
          Release
        </Button>
      </DialogActions>
    </Dialog>
  );
}
