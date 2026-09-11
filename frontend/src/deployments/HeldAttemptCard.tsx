import { Box, Button, Stack, Typography } from '@mui/material';

import {
  describeAttemptHold,
  type DeployAttemptView,
} from '@streaming-infra-manager/common';

import { MONO_STACK } from '../app/theme';
import { SectionCard } from '../components/SectionCard';
import { formatDateTime } from '../format';

/**
 * A deploy attempt on this deployment that a person has to end: blocked, or
 * still counted as running because the manager could not judge it when its
 * script ended. Either way the next deploy is refused until it is released.
 */
export function HeldAttemptCard({
  attempt,
  onRelease,
}: {
  attempt: DeployAttemptView;
  onRelease: () => void;
}) {
  const blocked = attempt.state === 'blocked';
  return (
    <SectionCard tone="error">
      <Stack spacing={1}>
        <Typography sx={{ fontWeight: 600, color: 'error.main' }}>
          {blocked
            ? 'A blocked deploy attempt holds this deployment'
            : 'An unjudged deploy attempt holds this deployment'}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Attempt {attempt.jobId}, started {formatDateTime(attempt.startedAt)}.{' '}
          {describeAttemptHold(attempt)}
        </Typography>
        {attempt.reason && (
          <Box
            component="pre"
            sx={{
              m: 0,
              fontFamily: MONO_STACK,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {attempt.reason}
          </Box>
        )}
        <Typography variant="body2">
          {blocked
            ? `Deploying ${attempt.project} again is refused until this attempt is released. Release it only after checking the host.`
            : `The manager never got to judge this attempt, so it still counts as running, and deploying ${attempt.project} again is refused until it is released. Release it only after checking the host.`}
        </Typography>
        <Box>
          <Button color="error" variant="outlined" size="small" onClick={onRelease}>
            Release
          </Button>
        </Box>
      </Stack>
    </SectionCard>
  );
}
