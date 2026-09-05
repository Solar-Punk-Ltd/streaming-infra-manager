import { Box } from '@mui/material';

import { tonePillStyles, type Tone } from './tone';

/** A short verdict on a coloured wash: "Ready to stream", "Needs a stamp". */
export function ReadinessPill({
  label,
  tone,
  title,
}: {
  label: string;
  tone: Tone;
  title?: string;
}) {
  return (
    <Box
      component="span"
      title={title}
      sx={(theme) => ({
        ...tonePillStyles(theme, tone),
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        px: 1.1,
        py: 0.25,
        borderRadius: 99,
        fontSize: '0.75rem',
        fontWeight: 500,
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
      })}
    >
      {label}
    </Box>
  );
}
