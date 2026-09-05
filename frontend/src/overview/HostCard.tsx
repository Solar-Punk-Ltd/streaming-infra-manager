import { Box, Button, Stack, Typography } from '@mui/material';

import { navigate, routes } from '../app/router';
import { SectionCard } from '../components/SectionCard';
import { SegmentedBar } from '../components/SegmentedBar';
import { MONO_STACK } from '../app/theme';
import {
  formatBytes,
  formatCores,
  formatPercent,
} from '../format';
import { hostShares, type ResourceShare } from '../resources/metricsMath';
import type { MetricsSnapshot } from '../types';

export function HostCard({
  snapshot,
  serverHost,
}: {
  snapshot: MetricsSnapshot | null;
  serverHost: string;
}) {
  return (
    <SectionCard
      title="Host"
      sub={
        snapshot
          ? `${serverHost} · ${snapshot.host.ncpu} cores · ${formatBytes(snapshot.host.memTotalBytes)}`
          : serverHost
      }
      actions={
        <Button size="small" onClick={() => navigate(routes.host)}>
          Details
        </Button>
      }
    >
      {snapshot ? (
        <Bars snapshot={snapshot} />
      ) : (
        <Typography variant="body2" color="text.secondary">
          Waiting for the first sample…
        </Typography>
      )}
    </SectionCard>
  );
}

function Bars({ snapshot }: { snapshot: MetricsSnapshot }) {
  const shares = hostShares(snapshot);

  return (
    <Stack spacing={1.75}>
      <Bar
        label="CPU"
        value={formatPercent(snapshot.host.cpuPercent)}
        share={shares.cpu}
        footnote={`our stacks ${formatCores(snapshot.infra.cpuPercent)} cores · everything else ${formatCores(snapshot.outside.cpuPercent ?? 0)} cores`}
      />
      <Bar
        label="Memory"
        value={`${formatBytes(snapshot.host.memUsedBytes)} / ${formatBytes(snapshot.host.memTotalBytes)}`}
        share={shares.memory}
        footnote={`our stacks ${formatBytes(snapshot.infra.memUsageBytes)} · everything else ${formatBytes(snapshot.outside.memUsageBytes)}`}
      />
      <Bar
        label="Disk"
        value={`${formatBytes(snapshot.host.diskUsedBytes)} / ${formatBytes(snapshot.host.diskTotalBytes)}`}
        share={shares.disk}
        footnote="whole root filesystem"
      />
    </Stack>
  );
}

function Bar({
  label,
  value,
  share,
  footnote,
}: {
  label: string;
  value: string;
  share: ResourceShare;
  footnote: string;
}) {
  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="baseline">
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {label}
        </Typography>
        <Typography variant="caption" sx={{ fontFamily: MONO_STACK }}>
          {value}
        </Typography>
      </Stack>
      <Box sx={{ my: 0.75 }}>
        <SegmentedBar ours={share.ours} other={share.other} height={8} />
      </Box>
      <Typography variant="caption" color="text.secondary">
        {footnote}
      </Typography>
    </Box>
  );
}
