import { Box } from '@mui/material';

import { toneMainColor, type Tone } from './tone';

const SIZE = 9;

/** A coloured dot. Pulsing means the deployment is mid-change. */
export function StatusDot({
  tone,
  pulsing = false,
}: {
  tone: Tone;
  pulsing?: boolean;
}) {
  return (
    <Box
      component="span"
      sx={(theme) => ({
        display: 'inline-block',
        flex: 'none',
        width: SIZE,
        height: SIZE,
        borderRadius: '50%',
        backgroundColor: toneMainColor(theme, tone),
        animation: pulsing ? 'statusDotPulse 1.2s ease-in-out infinite' : 'none',
        '@keyframes statusDotPulse': {
          '0%, 100%': { opacity: 1 },
          '50%': { opacity: 0.35 },
        },
      })}
    />
  );
}
