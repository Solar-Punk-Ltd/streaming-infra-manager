import { useEffect, useRef } from 'react';
import { Box, Typography } from '@mui/material';

import { MONO_STACK } from '../app/theme';

import type { BuildLine } from './versionsApi';

const PANE_HEIGHT = 260;

/** Colour alone does not read as an error on every screen or to every eye. */
const STDERR_PREFIX = 'stderr ';

/**
 * The clone and the build as they happen.
 *
 * A build takes minutes, and the useful half of a failure is always the last
 * few lines, so the pane follows the end of the log rather than staying where
 * the reader last scrolled.
 */
export function BuildLogPane({
  lines,
  running,
}: {
  lines: BuildLine[];
  running: boolean;
}) {
  const end = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [lines.length]);

  return (
    <Box
      sx={{
        height: PANE_HEIGHT,
        overflow: 'auto',
        p: 1.5,
        borderRadius: 1,
        border: 1,
        borderColor: 'divider',
        bgcolor: 'action.hover',
      }}
    >
      {lines.length === 0 && (
        <Typography variant="caption" color="text.secondary">
          {running
            ? 'Waiting for the first line of the build.'
            : 'The build log appears here once a version is added or updated.'}
        </Typography>
      )}
      {lines.map((line) => (
        <Typography
          key={line.id}
          component="pre"
          variant="caption"
          color={line.isError ? 'error.main' : 'text.secondary'}
          sx={{
            fontFamily: MONO_STACK,
            m: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {line.isError ? `${STDERR_PREFIX}${line.text}` : line.text}
        </Typography>
      ))}
      <div ref={end} />
    </Box>
  );
}
