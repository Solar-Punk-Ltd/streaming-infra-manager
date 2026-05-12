import { Chip } from '@mui/material';

import type { ProfileStatus } from './types';

const COLOR: Record<ProfileStatus, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  RUNNING: 'success',
  DEPLOYING: 'info',
  STOPPING: 'warning',
  STOPPED: 'default',
  REMOVING: 'warning',
  ERROR: 'error',
};

export function StatusChip({ status }: { status: ProfileStatus }) {
  return <Chip size="small" label={status} color={COLOR[status]} variant="outlined" />;
}
