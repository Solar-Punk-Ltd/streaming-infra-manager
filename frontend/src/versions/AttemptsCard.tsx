import { Alert, Box, Button, Stack, Typography } from '@mui/material';

import {
  describeAttemptHold,
  type DeployAttemptView,
} from '@streaming-infra-manager/common';

import { MONO_STACK } from '../app/theme';
import { ReadinessPill } from '../components/ReadinessPill';
import { SectionCard } from '../components/SectionCard';
import type { Tone } from '../components/tone';
import { formatDateTime } from '../format';

const STATE_LABELS: Record<DeployAttemptView['state'], string> = {
  open: 'Running',
  blocked: 'Blocked',
  released: 'Released',
};

const STATE_TONES: Record<DeployAttemptView['state'], Tone> = {
  open: 'warn',
  blocked: 'err',
  released: 'ok',
};

const RUNNING_RESOLVES_ITSELF =
  'Judged when its script ends: released once every service it touched has a new container.';

const NEVER_JUDGED =
  'Its script ended but the manager never got to judge it, so it still counts as running. Release it after checking the host.';

/**
 * The deploy attempts still holding something, on the Versions page because
 * an attempt on a version with shared image tags holds every such deploy on
 * the host, not one deployment alone.
 */
export function AttemptsCard({
  attempts,
  error,
  canRelease,
  onRelease,
  onReload,
}: {
  attempts: DeployAttemptView[];
  error: string | null;
  /** Whether a person has to end this one, rather than the deploy it belongs to. */
  canRelease: (attempt: DeployAttemptView) => boolean;
  onRelease: (attempt: DeployAttemptView) => void;
  onReload: () => void;
}) {
  return (
    <SectionCard
      title="Deploy attempts"
      sub="Each holds its deployment until the manager can prove its build finished"
      flush
      actions={
        <Button size="small" onClick={onReload}>
          Refresh
        </Button>
      }
    >
      {error && (
        <Alert severity="error" sx={{ m: 2 }}>
          Could not read the deploy attempts from the manager. {error}
        </Alert>
      )}
      {attempts.map((attempt) => (
        <AttemptRow
          key={attempt.id}
          attempt={attempt}
          releasable={canRelease(attempt)}
          onRelease={() => onRelease(attempt)}
        />
      ))}
    </SectionCard>
  );
}

function AttemptRow({
  attempt,
  releasable,
  onRelease,
}: {
  attempt: DeployAttemptView;
  releasable: boolean;
  onRelease: () => void;
}) {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={2}
      alignItems={{ sm: 'center' }}
      sx={{ px: 2.25, py: 1.5, borderBottom: 1, borderColor: 'divider' }}
    >
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="body2" sx={{ fontWeight: 500 }}>
            {attempt.project}
          </Typography>
          <ReadinessPill
            label={STATE_LABELS[attempt.state]}
            tone={STATE_TONES[attempt.state]}
          />
          <Typography variant="caption" sx={{ fontFamily: MONO_STACK }}>
            {attempt.jobId}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            started {formatDateTime(attempt.startedAt)}
          </Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {describeAttemptHold(attempt)}
        </Typography>
        <Typography
          variant="caption"
          color={attempt.reason ? 'error.main' : 'text.secondary'}
          sx={{ display: 'block', fontFamily: MONO_STACK, whiteSpace: 'pre-wrap' }}
        >
          {attempt.reason ?? (releasable ? NEVER_JUDGED : RUNNING_RESOLVES_ITSELF)}
        </Typography>
      </Box>
      {releasable && (
        <Button
          size="small"
          color="error"
          variant="outlined"
          onClick={onRelease}
          sx={{ flex: 'none' }}
        >
          Release
        </Button>
      )}
    </Stack>
  );
}
