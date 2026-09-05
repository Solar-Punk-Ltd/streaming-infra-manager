import { Box } from '@mui/material';

import { MONO_STACK } from '../app/theme';

/** A service name kept visible for the people who need it, in small monospace. */
export function ServiceChip({ service }: { service: string }) {
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-block',
        fontFamily: MONO_STACK,
        fontSize: '0.71875rem',
        px: 0.75,
        py: 0.125,
        borderRadius: 1.5,
        border: 1,
        borderColor: 'divider',
        bgcolor: 'action.hover',
        color: 'text.secondary',
        whiteSpace: 'nowrap',
      }}
    >
      {service}
    </Box>
  );
}
