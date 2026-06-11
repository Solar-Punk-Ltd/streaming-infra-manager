import { Box } from '@mui/material';
import { Typography } from '@mui/material';

import {
  formatBytes,
  formatCores,
  formatRate,
  formatSharePercent,
} from '../format';
import type { HostMetrics, InfraTotals } from '../types';
import { StatCard } from './StatCard';

export function InfraSummary({
  infra,
  host,
}: {
  infra: InfraTotals;
  host: HostMetrics;
}) {
  return (
    <Box>
      <Typography variant="h6">Our infra — deployed by this tool</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Only containers this tool started, grouped per profile. Other stacks on
        the host are excluded.
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: {
            xs: '1fr 1fr',
            md: 'repeat(5, 1fr)',
          },
          gap: 2,
        }}
      >
        <StatCard
          title="CPU"
          value={`${formatSharePercent(infra.cpuPercent, host.ncpu * 100)} of host`}
          sub={`${formatCores(infra.cpuPercent)} cores`}
        />
        <StatCard
          title="Memory"
          value={`${formatSharePercent(infra.memUsageBytes, host.memTotalBytes)} of host`}
          sub={formatBytes(infra.memUsageBytes)}
        />
        <StatCard
          title="Network"
          value={`↓ ${formatBytes(infra.netRxBytes)}  ↑ ${formatBytes(infra.netTxBytes)}`}
          sub={`now ↓ ${formatRate(infra.netRxRate)}  ↑ ${formatRate(infra.netTxRate)}`}
        />
        <StatCard
          title="Disk I/O"
          value={`R ${formatBytes(infra.blkReadBytes)}  W ${formatBytes(infra.blkWriteBytes)}`}
          sub={`now R ${formatRate(infra.blkReadRate)}  W ${formatRate(infra.blkWriteRate)}`}
        />
        <StatCard
          title="Containers"
          value={String(infra.containerCount)}
          sub="running"
        />
      </Box>
    </Box>
  );
}
