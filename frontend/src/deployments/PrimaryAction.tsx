import { Box, Button, CircularProgress } from '@mui/material';

import { useActions } from '../app/useDeploymentActions';
import type { Profile } from '../types';
import { isRunning, isTransitional, statusLabelOf } from './shape';

/**
 * The one button a deployment always has: Stop while it runs, Start or Retry
 * while it does not, and a disabled spinner naming the change in between.
 */
export function PrimaryAction({
  profile,
  size = 'small',
}: {
  profile: Profile;
  size?: 'small' | 'medium';
}) {
  const actions = useActions();
  const busy = isTransitional(profile) || actions.isBusy(profile.name);

  if (busy) {
    return (
      <Button size={size} disabled startIcon={<CircularProgress size={12} />}>
        <Box component="span" sx={{ whiteSpace: 'nowrap' }}>
          {statusLabelOf(profile).label}…
        </Box>
      </Button>
    );
  }

  if (isRunning(profile)) {
    return (
      <Button size={size} onClick={() => actions.stop(profile.name)}>
        Stop
      </Button>
    );
  }

  return (
    <Button
      size={size}
      variant="contained"
      onClick={() => actions.start(profile.name)}
    >
      {profile.status === 'ERROR' ? 'Retry' : 'Start'}
    </Button>
  );
}
