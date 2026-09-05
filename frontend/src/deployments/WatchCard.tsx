import { Stack, Typography } from '@mui/material';

import { MONO_STACK } from '../app/theme';
import { CopyBox } from '../components/CopyBox';
import { SectionCard } from '../components/SectionCard';
import { shortHex } from '../format';

export function WatchCard({
  url,
  feedOwner,
  streamerName,
}: {
  url: string;
  feedOwner: string | null | undefined;
  /** The stream on this manager that owns the address, when there is one. */
  streamerName: string | null;
}) {
  return (
    <SectionCard title="Watch" sub="the player this deployment serves">
      <Stack spacing={1.25}>
        <CopyBox value={url} href={url} />
        <Typography variant="caption" color="text.secondary">
          Follows{' '}
          {streamerName ? (
            <Typography component="span" variant="caption" sx={{ fontFamily: MONO_STACK, fontWeight: 600 }}>
              {streamerName}
            </Typography>
          ) : (
            'an external streamer'
          )}{' '}
          · address{' '}
          <Typography component="span" variant="caption" sx={{ fontFamily: MONO_STACK }}>
            {feedOwner ? shortHex(feedOwner) : 'not set'}
          </Typography>
        </Typography>
      </Stack>
    </SectionCard>
  );
}
