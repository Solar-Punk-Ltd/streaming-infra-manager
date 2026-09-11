import { useEffect, useRef } from 'react';
import { Box, Stack, Typography } from '@mui/material';

import { MONO_STACK } from '../app/theme';
import { SectionCard } from '../components/SectionCard';
import { formatDateTime } from '../format';

/**
 * How much of the page a failed deploy's output may take before it scrolls
 * inside its own box.
 *
 * A first deploy of a version pulls its images, and `docker compose` prints a
 * line per progress tick with no terminal to rewrite. Measured on 2026-09-11:
 * 135 lines, 2412 pixels, with the one line that says what failed at the
 * bottom of them and the rest of the deployment page pushed below that.
 */
const LOG_MAX_HEIGHT = 260;

/** What the deploy script printed when it gave up, verbatim, newest line first in view. */
export function LastErrorCard({
  message,
  at,
}: {
  message: string;
  at: string | null;
}) {
  const log = useRef<HTMLElement>(null);
  // The end is where the failure is. A pull that preceded it is evidence to
  // scroll back through, not the first thing to read.
  useEffect(() => {
    const node = log.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [message]);

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
          ref={log}
          sx={{
            m: 0,
            fontFamily: MONO_STACK,
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: LOG_MAX_HEIGHT,
            overflowY: 'auto',
          }}
        >
          {message}
        </Box>
      </Stack>
    </SectionCard>
  );
}
