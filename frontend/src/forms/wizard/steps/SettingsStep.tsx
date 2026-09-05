import { Box, Stack, Typography } from '@mui/material';

import type { WizardGoal, WizardStepProps } from '../wizardState';
import { CustomSettings } from './CustomSettings';
import { PoolSettings } from './PoolSettings';
import { StreamSettings } from './StreamSettings';
import { UploaderSettings } from './UploaderSettings';
import { ViewerSettings } from './ViewerSettings';

const HEADINGS: Record<WizardGoal, { title: string; lead: string }> = {
  stream: {
    title: 'Stream settings',
    lead: 'Ingest, identity and storage. The stamp can wait until the node is funded.',
  },
  viewer: {
    title: 'Viewer settings',
    lead: 'A viewer follows one streamer address.',
  },
  'abr-pool': {
    title: 'Pool settings',
    lead: 'Nothing to decide here. A pool always has these four nodes.',
  },
  'abr-uploader': {
    title: 'ABR uploader settings',
    lead: 'Encodes 360p to 1080p and publishes each rung to its own Bee node in the pool.',
  },
  custom: {
    title: 'Custom components',
    lead: 'Pick what runs. Fields appear for the components that need them.',
  },
};

export function SettingsStep(props: WizardStepProps) {
  const goal = props.state.goal;
  if (!goal) return null;
  const heading = HEADINGS[goal];

  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="h6" component="h4">
          {heading.title}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {heading.lead}
        </Typography>
      </Box>
      <SettingsBody goal={goal} {...props} />
    </Stack>
  );
}

function SettingsBody({ goal, ...props }: WizardStepProps & { goal: WizardGoal }) {
  if (goal === 'stream') return <StreamSettings {...props} />;
  if (goal === 'viewer') return <ViewerSettings {...props} />;
  if (goal === 'abr-pool') return <PoolSettings {...props} />;
  if (goal === 'abr-uploader') return <UploaderSettings {...props} />;
  return <CustomSettings {...props} />;
}
