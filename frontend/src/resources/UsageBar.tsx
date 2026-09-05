import { Box } from '@mui/material';

export const INFRA_COLOR = 'primary.main';
// A palette path rather than a fixed rgba: the same bar is read on a white and
// on a near-black background, and a hard-coded white wash disappears on one of them.
export const OTHER_COLOR = 'text.disabled';

export interface Segment {
  fraction: number;
  color: string;
}

export function UsageBar({
  segments,
  height = 12,
}: {
  segments: Segment[];
  height?: number;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        height,
        borderRadius: 1,
        overflow: 'hidden',
        bgcolor: 'action.hover',
      }}
    >
      {segments.map((s, i) => (
        <Box
          key={i}
          sx={{
            width: `${Math.max(0, Math.min(1, s.fraction)) * 100}%`,
            bgcolor: s.color,
          }}
        />
      ))}
    </Box>
  );
}
