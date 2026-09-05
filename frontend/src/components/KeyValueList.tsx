import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';

export interface KeyValueEntry {
  key: string;
  value: ReactNode;
}

/** A definition list: labels in a fixed column, values wrapping beside them. */
export function KeyValueList({
  entries,
  labelWidth = 160,
}: {
  entries: KeyValueEntry[];
  labelWidth?: number;
}) {
  return (
    <Box
      component="dl"
      sx={{
        m: 0,
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: `${labelWidth}px 1fr` },
        rowGap: 1,
        columnGap: 2,
        alignItems: 'baseline',
      }}
    >
      {entries.map((entry) => (
        <Box key={entry.key} sx={{ display: 'contents' }}>
          <Typography component="dt" variant="body2" color="text.secondary">
            {entry.key}
          </Typography>
          <Box
            component="dd"
            sx={{ m: 0, fontSize: '0.8125rem', wordBreak: 'break-word' }}
          >
            {entry.value}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
