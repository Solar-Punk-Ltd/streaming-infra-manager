import { Box, Stack, Typography } from '@mui/material';
import type { ReactNode } from 'react';

/**
 * What to say when there is nothing to show. Every one of these carries the
 * next step, so an empty panel is never a dead end.
 */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <Stack spacing={1.5} alignItems="center" sx={{ px: 3, py: 5 }}>
      <Typography variant="body2" color="text.secondary">
        {title}
      </Typography>
      {hint && (
        <Typography variant="caption" color="text.secondary" textAlign="center">
          {hint}
        </Typography>
      )}
      {action && <Box>{action}</Box>}
    </Stack>
  );
}
