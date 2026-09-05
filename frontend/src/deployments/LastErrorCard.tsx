import { Box, Stack, Typography } from '@mui/material';

import { MONO_STACK } from '../app/theme';
import { SectionCard } from '../components/SectionCard';
import { formatDateTime } from '../format';

/** What the deploy script printed when it gave up, verbatim. */
export function LastErrorCard({
  message,
  at,
}: {
  message: string;
  at: string | null;
}) {
  return (
    <SectionCard tone="error">
      <Stack spacing={1}>
        <Typography sx={{ fontWeight: 600, color: 'error.main' }}>
          Last deploy failed
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {formatDateTime(at)}
        </Typography>
        <Box
          component="pre"
          sx={{
            m: 0,
            fontFamily: MONO_STACK,
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {message}
        </Box>
      </Stack>
    </SectionCard>
  );
}
