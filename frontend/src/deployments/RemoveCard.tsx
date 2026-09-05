import { Box, Button, Stack, Typography } from '@mui/material';

import { useActions } from '../app/useDeploymentActions';
import { SectionCard } from '../components/SectionCard';
import type { Profile } from '../types';

export function RemoveCard({ profile }: { profile: Profile }) {
  const actions = useActions();

  return (
    <SectionCard tone="error">
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        alignItems={{ sm: 'center' }}
      >
        <Box sx={{ flexGrow: 1 }}>
          <Typography sx={{ fontWeight: 600 }}>
            Remove this deployment
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Stops the containers, deletes the record and wipes its data directory
            on the host. This cannot be undone.
          </Typography>
        </Box>
        <Button
          color="error"
          variant="outlined"
          onClick={() => actions.requestRemove(profile)}
          sx={{ flex: 'none' }}
        >
          Remove
        </Button>
      </Stack>
    </SectionCard>
  );
}
