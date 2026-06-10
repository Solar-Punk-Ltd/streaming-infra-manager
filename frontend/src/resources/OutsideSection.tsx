import { Box } from '@mui/material';
import { Typography } from '@mui/material';

import {
  formatBytes,
  formatCores,
  formatPercent,
  formatRate,
  formatSharePercent,
} from '../format';
import type { HostMetrics, InfraTotals, OutsideTotals } from '../types';
import { StatCard } from './StatCard';

export function OutsideSection({
  host,
  infra,
  outside,
}: {
  host: HostMetrics;
  infra: InfraTotals;
  outside: OutsideTotals;
}) {
  const outsideCpuShare =
    outside.cpuPercent != null && host.ncpu > 0
      ? (outside.cpuPercent / (host.ncpu * 100)) * 100
      : null;

  return (
    <Box>
      <Typography variant="h6">Outside our infra</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        The host minus what this tool deployed. CPU and memory are exact (our
        usage is a subset of the host's); network and disk I/O can't be cleanly
        subtracted, so host and ours are shown side by side.
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, 1fr)' },
          gap: 2,
        }}
      >
        <StatCard
          title="CPU (host − ours)"
          value={
            outside.cpuPercent != null
              ? `${formatCores(outside.cpuPercent)} cores`
              : '—'
          }
          sub={
            outsideCpuShare != null
              ? `${formatPercent(outsideCpuShare)} of host`
              : undefined
          }
        />
        <StatCard
          title="Memory (host − ours)"
          value={formatBytes(outside.memUsageBytes)}
          sub={
            outside.memUsageBytes != null && host.memTotalBytes
              ? `${formatSharePercent(outside.memUsageBytes, host.memTotalBytes)} of host`
              : undefined
          }
        />
        <StatCard
          title="Network (host vs ours)"
          value={`Host now ↓ ${formatRate(host.netRxRate)} ↑ ${formatRate(host.netTxRate)}`}
          sub={`Ours now ↓ ${formatRate(infra.netRxRate)} ↑ ${formatRate(infra.netTxRate)}`}
        />
        <StatCard
          title="Disk I/O (host vs ours)"
          value={`Host now R ${formatRate(host.diskReadRate)} W ${formatRate(host.diskWriteRate)}`}
          sub={`Ours now R ${formatRate(infra.blkReadRate)} W ${formatRate(infra.blkWriteRate)}`}
        />
      </Box>
    </Box>
  );
}
