import { Alert, Box, CircularProgress, Stack } from '@mui/material';

import {
  defaultServicesFor,
  servicesNeedStamp,
} from '@streaming-infra-manager/common';

import type { Profile } from '../types';
import { UploaderCard } from './UploaderCard';

export function UploadersView({
  profiles,
  onChanged,
  srtPassphrase,
}: {
  profiles: Profile[] | null;
  onChanged: () => void;
  srtPassphrase: string | null;
}) {
  if (!profiles) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  const uploaderProfiles = profiles.filter((p) =>
    servicesNeedStamp(defaultServicesFor(p)),
  );

  if (uploaderProfiles.length === 0) {
    return (
      <Alert severity="info">
        No uploader instances yet. Deploy a streamer (or a custom profile with
        the <code>stream-uploader</code> component) to manage postage stamps
        here.
      </Alert>
    );
  }

  return (
    <Stack spacing={1}>
      {uploaderProfiles.map((p) => (
        <UploaderCard
          key={p.name}
          profile={p}
          onChanged={onChanged}
          srtPassphrase={srtPassphrase}
        />
      ))}
    </Stack>
  );
}
