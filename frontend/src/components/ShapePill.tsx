import { Box } from '@mui/material';

/** A neutral label for what a thing is: Stream, Viewer, ABR node pool. */
export function ShapePill({ label }: { label: string }) {
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        px: 1.1,
        py: 0.25,
        borderRadius: 99,
        bgcolor: 'action.hover',
        color: 'text.secondary',
        fontSize: '0.75rem',
        fontWeight: 500,
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </Box>
  );
}
