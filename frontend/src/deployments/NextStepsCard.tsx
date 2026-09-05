import { Button, Stack, Typography } from '@mui/material';

import { useEditors } from '../app/EditorsContext';
import { SectionCard } from '../components/SectionCard';

/** The obvious thing to build next from a running stream. */
export function NextStepsCard({ streamName }: { streamName: string }) {
  const { openWizard } = useEditors();

  return (
    <SectionCard title="Next steps">
      <Stack spacing={1}>
        <Button
          onClick={() =>
            openWizard({
              goal: 'viewer',
              feedStreamer: streamName,
              name: `${streamName}-viewer`,
            })
          }
        >
          Create a viewer for this stream
        </Button>
        <Typography variant="caption" color="text.secondary">
          Sets the viewer to follow this stream's address, so nothing has to be
          copied by hand.
        </Typography>
      </Stack>
    </SectionCard>
  );
}
