import { Stack } from '@mui/material';

import type { WizardStepProps } from '../wizardState';
import { FeedChoice } from './FeedChoice';
import { NodeModeChoice } from './NodeModeChoice';
import { RpcEndpointChoice } from './RpcEndpointChoice';

export function ViewerSettings(props: WizardStepProps) {
  return (
    <Stack spacing={2.5}>
      <FeedChoice {...props} />
      <NodeModeChoice {...props} />
      <RpcEndpointChoice {...props} />
    </Stack>
  );
}
