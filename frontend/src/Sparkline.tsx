import { Box } from '@mui/material';

function toPolylinePoints(
  values: number[],
  width: number,
  height: number,
  floor: number,
): string {
  const max = Math.max(...values, floor);
  return values
    .map((value, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - (Math.min(value, max) / max) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

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
  floor?: number;
}) {
  if (values.length < 2) {
    return <Box sx={{ width, height }} />;
  }

  const points = toPolylinePoints(values, width, height, floor);

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
