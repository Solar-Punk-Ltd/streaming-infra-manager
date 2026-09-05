import { Box, Paper, Stack, Typography } from '@mui/material';

import { SegmentedBar } from '../components/SegmentedBar';
import {
  formatBytes,
  formatCores,
  formatPercent,
} from '../format';
import type { MetricsSnapshot } from '../types';
import { hostShares, type ResourceShare } from './metricsMath';
import { INFRA_COLOR, OTHER_COLOR } from './UsageBar';

/** The three headline resources, each split into ours and everything else. */
export function HostBars({ snapshot }: { snapshot: MetricsSnapshot }) {
  const { host, infra, outside } = snapshot;
  const shares = hostShares(snapshot);

  return (
    <Box
      sx={{
        display: 'grid',
        gap: 2,
        gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' },
      }}
    >
      <HostStat
        label="CPU"
        value={formatPercent(host.cpuPercent)}
        sub={`${formatCores(
          host.cpuPercent != null ? host.cpuPercent * host.ncpu : null,
        )} of ${host.ncpu} cores in use`}
        share={shares.cpu}
        footnote={`our stacks ${formatCores(infra.cpuPercent)} cores · everything else ${formatCores(outside.cpuPercent ?? 0)} cores`}
      />
      <HostStat
        label="Memory"
        value={formatPercent((shares.memory.ours + shares.memory.other) * 100)}
        sub={`${formatBytes(host.memUsedBytes)} of ${formatBytes(host.memTotalBytes)}`}
        share={shares.memory}
        footnote={`our stacks ${formatBytes(infra.memUsageBytes)} · everything else ${formatBytes(outside.memUsageBytes)}`}
      />
      <HostStat
        label="Disk"
        value={formatPercent(shares.disk.other * 100)}
        sub={`${formatBytes(host.diskUsedBytes)} of ${formatBytes(host.diskTotalBytes)}`}
        share={shares.disk}
        footnote="whole root filesystem · per-deployment data size is in the table"
      />
    </Box>
  );
}

function HostStat({
  label,
  value,
  sub,
  share,
  footnote,
}: {
  label: string;
  value: string;
  sub: string;
  share: ResourceShare;
  footnote: string;
}) {
  return (
    <Paper sx={{ p: 2 }}>
      <Typography variant="overline" color="text.secondary">
        {label}
      </Typography>
      <Stack direction="row" spacing={1.25} alignItems="baseline">
        <Typography sx={{ fontSize: 26, fontWeight: 600 }}>{value}</Typography>
        <Typography variant="caption" color="text.secondary">
          {sub}
        </Typography>
      </Stack>
      <Box sx={{ my: 1.25 }}>
        <SegmentedBar ours={share.ours} other={share.other} />
      </Box>
      <Typography variant="caption" color="text.secondary">
        {footnote}
      </Typography>
    </Paper>
  );
}

export function HostLegend() {
  return (
    <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
      <LegendItem color={INFRA_COLOR} label="our stacks" />
      <LegendItem
        color={OTHER_COLOR}
        label="everything else on the machine (other containers, system)"
      />
      <LegendItem color="action.hover" label="free" />
    </Stack>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center">
      <Box sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: color }} />
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Stack>
  );
}
