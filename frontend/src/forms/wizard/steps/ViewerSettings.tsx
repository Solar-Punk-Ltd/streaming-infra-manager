import { Stack } from '@mui/material';

import type { WizardStepProps } from '../wizardState';
import { FeedChoice } from './FeedChoice';

export function ViewerSettings(props: WizardStepProps) {
  return (
    <Stack spacing={2.5}>
      <FeedChoice {...props} />
    </Stack>
  );
}
