import { Box, Stack, Typography } from '@mui/material';

import { CopyButton } from '../CopyButton';

export function StreamPublishUrl({ streamUrl }: { streamUrl: string | null }) {
  return (
    <Box>
      <Typography variant="overline" color="text.secondary">
        Stream here (SRT publish)
      </Typography>
      {streamUrl ? (
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography
            variant="body2"
            sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
          >
            {streamUrl}
          </Typography>
          <CopyButton value={streamUrl} label="stream URL" />
        </Stack>
      ) : (
        <Typography variant="body2" color="text.disabled">
          Deploy the streamer to get its SRT port.
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary">
        Point OBS / FFmpeg here. Change <code>live/stream</code> to your
        app/stream; if the deployment sets an SRT passphrase, append{' '}
        <code>&amp;passphrase=…</code>.
      </Typography>
    </Box>
  );
}
