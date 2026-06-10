import { Chip, Stack, TableCell, TableRow, Typography } from '@mui/material';

import {
  formatBytes,
  formatCores,
  formatRate,
  formatSharePercent,
} from '../format';
import { Sparkline } from '../Sparkline';
import type { ContainerMetrics } from '../types';
import { cpuFractionOfHost, fractionOf } from './metricsMath';
import { INFRA_COLOR, UsageBar } from './UsageBar';

export function ContainerRow({
  c,
  ncpu,
  memTotalBytes,
  history,
}: {
  c: ContainerMetrics;
  ncpu: number;
  memTotalBytes: number;
  history?: number[];
}) {
  const cpuFraction = cpuFractionOfHost(c.cpuPercent, ncpu);
  const memFraction = fractionOf(c.memUsageBytes, memTotalBytes);
  return (
    <TableRow>
      <TableCell sx={{ pl: 6 }}>{c.service ?? c.name}</TableCell>
      <TableCell>
        <Chip
          size="small"
          label={c.state}
          color={c.state === 'running' ? 'success' : 'default'}
          variant="outlined"
        />
      </TableCell>
      <TableCell sx={{ minWidth: 160 }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="body2" sx={{ minWidth: 52 }}>
            {formatSharePercent(c.cpuPercent, ncpu * 100)}
          </Typography>
          {history && <Sparkline values={history} />}
        </Stack>
        <Typography variant="caption" color="text.secondary">
          {formatCores(c.cpuPercent)} cores
        </Typography>
        <UsageBar
          segments={[{ fraction: cpuFraction, color: INFRA_COLOR }]}
          height={6}
        />
      </TableCell>
      <TableCell sx={{ minWidth: 150 }}>
        <Typography variant="body2">
          {formatSharePercent(c.memUsageBytes, memTotalBytes)}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {formatBytes(c.memUsageBytes)} / {formatBytes(c.memLimitBytes)}
        </Typography>
        <UsageBar
          segments={[{ fraction: memFraction, color: INFRA_COLOR }]}
          height={6}
        />
      </TableCell>
      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
        <Typography variant="body2">
          ↓ {formatBytes(c.netRxBytes)} ↑ {formatBytes(c.netTxBytes)}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          now ↓ {formatRate(c.netRxRate)} ↑ {formatRate(c.netTxRate)}
        </Typography>
      </TableCell>
      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
        <Typography variant="body2">
          R {formatBytes(c.blkReadBytes)} W {formatBytes(c.blkWriteBytes)}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          now R {formatRate(c.blkReadRate)} W {formatRate(c.blkWriteRate)}
        </Typography>
      </TableCell>
      <TableCell align="right">{c.pids}</TableCell>
    </TableRow>
  );
}
