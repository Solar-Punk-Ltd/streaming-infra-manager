import { Box, Stack, Typography } from '@mui/material';

import {
  formatBytes,
  formatCores,
  formatPercent,
  formatRate,
} from '../format';
import type { HostMetrics, InfraTotals } from '../types';
import { INFRA_COLOR, OTHER_COLOR, UsageBar, type Segment } from './UsageBar';
import { StatCard } from './StatCard';

function HostCard({
  title,
  headline,
  sub,
  segments,
  footnote,
}: {
  title: string;
  headline: string;
  sub: string;
  segments: Segment[];
  footnote?: string;
}) {
  return (
    <Box
      component="section"
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        p: 2,
      }}
    >
      <Typography variant="overline" color="text.secondary">
        {title}
      </Typography>
      <Stack direction="row" alignItems="baseline" spacing={1} sx={{ mb: 1 }}>
        <Typography variant="h4">{headline}</Typography>
        <Typography variant="body2" color="text.secondary">
          {sub}
        </Typography>
      </Stack>
      <UsageBar segments={segments} />
      {footnote && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ mt: 0.5, display: 'block' }}
        >
          {footnote}
        </Typography>
      )}
    </Box>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
      <Box sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: color }} />
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Stack>
  );
}

function Legend() {
  return (
    <Stack direction="row" spacing={2} sx={{ mt: 1 }}>
      <LegendItem color={INFRA_COLOR} label="Our infra" />
      <LegendItem color={OTHER_COLOR} label="Outside our infra" />
      <LegendItem color="action.hover" label="Free" />
    </Stack>
  );
}

export function HostSection({
  host,
  infra,
}: {
  host: HostMetrics;
  infra: InfraTotals;
}) {
  // CPU — fractions of the whole box (ncpu cores).
  const hostCpuFrac = host.cpuPercent != null ? host.cpuPercent / 100 : 0;
  const infraCpuFrac = host.ncpu > 0 ? infra.cpuPercent / 100 / host.ncpu : 0;
  const cpuSegments: Segment[] = [
    { fraction: infraCpuFrac, color: INFRA_COLOR },
    { fraction: Math.max(0, hostCpuFrac - infraCpuFrac), color: OTHER_COLOR },
  ];

  // Memory.
  const memTotal = host.memTotalBytes || 1;
  const hostMemFrac =
    host.memUsedBytes != null ? host.memUsedBytes / memTotal : 0;
  const infraMemFrac = infra.memUsageBytes / memTotal;
  const memSegments: Segment[] = [
    { fraction: infraMemFrac, color: INFRA_COLOR },
    { fraction: Math.max(0, hostMemFrac - infraMemFrac), color: OTHER_COLOR },
  ];

  const diskFrac =
    host.diskUsedBytes != null && host.diskTotalBytes
      ? host.diskUsedBytes / host.diskTotalBytes
      : 0;
  const diskSegments: Segment[] = [{ fraction: diskFrac, color: OTHER_COLOR }];

  // "Outside our infra" = host usage we didn't deploy (other containers incl.
  // the bee cluster, plus system). Absolute values for the card footnotes.
  const infraCores = infra.cpuPercent / 100;
  const hostUsedCores =
    host.cpuPercent != null ? (host.cpuPercent * host.ncpu) / 100 : 0;
  const outsideCores = Math.max(0, hostUsedCores - infraCores);
  const outsideMemBytes =
    host.memUsedBytes != null
      ? Math.max(0, host.memUsedBytes - infra.memUsageBytes)
      : null;

  return (
    <Box>
      <Typography variant="h6">Host — all resources</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        The whole machine. "Outside our infra" is everything we didn't deploy —
        other containers (incl. the bee cluster) and system processes.
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' },
          gap: 2,
        }}
      >
        <HostCard
          title="CPU"
          headline={
            host.cpuPercent != null ? formatPercent(host.cpuPercent) : '—'
          }
          sub={`${formatCores(
            host.cpuPercent != null ? host.cpuPercent * host.ncpu : null,
          )} / ${host.ncpu} cores`}
          segments={cpuSegments}
          footnote={`Our infra ${infraCores.toFixed(2)} cores (${formatPercent(
            infraCpuFrac * 100,
          )} of host) · Outside ${outsideCores.toFixed(2)} cores`}
        />
        <HostCard
          title="Memory"
          headline={formatPercent(hostMemFrac * 100)}
          sub={`${formatBytes(host.memUsedBytes)} / ${formatBytes(host.memTotalBytes)}`}
          segments={memSegments}
          footnote={`Our infra ${formatBytes(infra.memUsageBytes)} (${formatPercent(
            infraMemFrac * 100,
          )} of host) · Outside ${formatBytes(outsideMemBytes)}`}
        />
        <HostCard
          title="Disk"
          headline={formatPercent(diskFrac * 100)}
          sub={`${formatBytes(host.diskUsedBytes)} / ${formatBytes(host.diskTotalBytes)}`}
          segments={diskSegments}
          footnote="Whole root filesystem"
        />
        <StatCard
          title="Network"
          value={`↓ ${formatBytes(host.netRxBytes)}  ↑ ${formatBytes(host.netTxBytes)}`}
          sub={`now ↓ ${formatRate(host.netRxRate)}  ↑ ${formatRate(host.netTxRate)}`}
        />
        <StatCard
          title="Disk I/O"
          value={`R ${formatBytes(host.diskReadBytes)}  W ${formatBytes(host.diskWriteBytes)}`}
          sub={`now R ${formatRate(host.diskReadRate)}  W ${formatRate(host.diskWriteRate)}`}
        />
      </Box>
      <Legend />
    </Box>
  );
}
