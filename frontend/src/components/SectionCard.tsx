import { Box, Paper, Stack, Typography } from '@mui/material';
import type { ReactNode } from 'react';

/**
 * The card frame every panel shares: a header line with a title, an optional
 * sub-line and right-aligned actions, then a body.
 *
 * `flush` drops the body padding for the cards whose body is a table or a list
 * that should reach the border.
 */
export function SectionCard({
  title,
  sub,
  actions,
  flush = false,
  id,
  tone,
  children,
}: {
  title?: string;
  sub?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
  id?: string;
  /** Border accent, for the cards that carry a warning or a danger action. */
  tone?: 'error';
  children: ReactNode;
}) {
  return (
    <Paper
      id={id}
      sx={{ overflow: 'hidden', borderColor: tone === 'error' ? 'error.main' : 'divider' }}
    >
      {(title || actions) && (
        <Stack
          direction="row"
          alignItems="center"
          spacing={1.25}
          sx={{
            px: 2.25,
            py: 1.5,
            borderBottom: 1,
            borderColor: 'divider',
            flexWrap: 'wrap',
          }}
        >
          {title && (
            <Typography variant="h6" component="h3">
              {title}
            </Typography>
          )}
          {sub && (
            <Typography variant="body2" color="text.secondary">
              {sub}
            </Typography>
          )}
          <Box sx={{ flexGrow: 1 }} />
          {actions}
        </Stack>
      )}
      <Box sx={flush ? undefined : { px: 2.25, py: 2 }}>{children}</Box>
    </Paper>
  );
}
