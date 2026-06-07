import { Box } from '@mui/material';

/**
 * Tiny inline-SVG trend line. Auto-scales to its own max (with a small floor
 * so an idle series stays visually flat rather than amplifying noise).
 */
export function Sparkline({
  values,
  width = 64,
  height = 18,
  color = '#90caf9',
  floor = 5,
}: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  /** Minimum value the y-axis spans, so near-zero series read as flat. */
  floor?: number;
}) {
  if (values.length < 2) {
    return <Box sx={{ width, height }} />;
  }

  const max = Math.max(...values, floor);
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - (Math.min(v, max) / max) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <Box component="svg" width={width} height={height} sx={{ display: 'block' }}>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </Box>
  );
}
