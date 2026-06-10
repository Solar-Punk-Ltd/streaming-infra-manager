import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Chip,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';

import {
  formatBytes,
  formatCores,
  formatPercent,
  formatRate,
  formatSharePercent,
} from './format';
import { Sparkline } from './Sparkline';
import type {
  ContainerMetrics,
  HostMetrics,
  InfraTotals,
  MetricsSnapshot,
  OutsideTotals,
} from './types';

/** Optional live extras layered on top of the snapshot. */
export interface MonitorExtras {
  /** containerId → recent cpuPercent samples, for sparklines. */
  history?: Map<string, number[]>;
  /** project → on-disk footprint in bytes (null = none / not yet loaded). */
  diskByProject?: Map<string, number | null>;
  /** Called when a profile group is shown, to lazily load its disk size. */
  onExpandProject?: (project: string) => void;
}

const INFRA_COLOR = 'primary.main';
const OTHER_COLOR = 'rgba(255,255,255,0.22)';

interface Segment {
  fraction: number;
  color: string;
}

function UsageBar({
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
    <Paper variant="outlined" sx={{ p: 2 }}>
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
    </Paper>
  );
}

function HostSection({
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
        The whole machine. “Outside our infra” is everything we didn’t deploy —
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

function StatCard({
  title,
  value,
  sub,
}: {
  title: string;
  value: string;
  sub?: string;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="overline" color="text.secondary">
        {title}
      </Typography>
      <Typography variant="h5">{value}</Typography>
      {sub && (
        <Typography variant="caption" color="text.secondary">
          {sub}
        </Typography>
      )}
    </Paper>
  );
}

function InfraSummary({
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

function OutsideSection({
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
        usage is a subset of the host’s); network and disk I/O can’t be cleanly
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

interface Group {
  project: string;
  containers: ContainerMetrics[];
  cpuPercent: number;
  memUsageBytes: number;
}

function groupByProject(containers: ContainerMetrics[]): Group[] {
  const map = new Map<string, ContainerMetrics[]>();
  for (const c of containers) {
    const key = c.project ?? '(unlabeled)';
    const arr = map.get(key) ?? [];
    arr.push(c);
    map.set(key, arr);
  }
  return [...map.entries()]
    .map(([project, list]) => ({
      project,
      containers: list.sort((a, b) =>
        (a.service ?? '').localeCompare(b.service ?? ''),
      ),
      cpuPercent: list.reduce((s, c) => s + c.cpuPercent, 0),
      memUsageBytes: list.reduce((s, c) => s + c.memUsageBytes, 0),
    }))
    // Stable alphabetical order so rows don't jump around as usage changes.
    .sort((a, b) => a.project.localeCompare(b.project));
}

function ContainerRow({
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
  const cpuFraction = ncpu > 0 ? c.cpuPercent / 100 / ncpu : 0; // of whole box
  const memFraction = memTotalBytes > 0 ? c.memUsageBytes / memTotalBytes : 0;
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

function GroupBlock({
  group,
  ncpu,
  memTotalBytes,
  extras,
}: {
  group: Group;
  ncpu: number;
  memTotalBytes: number;
  extras: MonitorExtras;
}) {
  const [open, setOpen] = useState(true);
  const { history, diskByProject, onExpandProject } = extras;

  // Lazily ask for this profile's disk footprint whenever it's expanded.
  useEffect(() => {
    if (open) onExpandProject?.(group.project);
  }, [open, group.project, onExpandProject]);

  const diskSize = diskByProject?.get(group.project);

  return (
    <>
      <TableRow
        hover
        sx={{ cursor: 'pointer', '& td': { borderBottom: 'none' } }}
        onClick={() => setOpen((v) => !v)}
      >
        <TableCell colSpan={2}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <IconButton
              size="small"
              aria-label={`${open ? 'collapse' : 'expand'} ${group.project}`}
              aria-expanded={open}
              onClick={(e) => {
                e.stopPropagation();
                setOpen((v) => !v);
              }}
            >
              {open ? (
                <ExpandMoreIcon fontSize="small" />
              ) : (
                <ChevronRightIcon fontSize="small" />
              )}
            </IconButton>
            <Typography variant="subtitle2">{group.project}</Typography>
            <Chip
              size="small"
              label={`${group.containers.length} containers`}
              variant="outlined"
            />
            {diskSize != null && (
              <Chip
                size="small"
                label={`data ${formatBytes(diskSize)}`}
                variant="outlined"
                color="info"
              />
            )}
          </Stack>
        </TableCell>
        <TableCell>
          <Tooltip title={`${formatCores(group.cpuPercent)} cores`}>
            <Typography variant="body2">
              {formatSharePercent(group.cpuPercent, ncpu * 100)}
            </Typography>
          </Tooltip>
        </TableCell>
        <TableCell>
          <Tooltip title={formatBytes(group.memUsageBytes)}>
            <Typography variant="body2">
              {formatSharePercent(group.memUsageBytes, memTotalBytes)}
            </Typography>
          </Tooltip>
        </TableCell>
        <TableCell colSpan={3} />
      </TableRow>
      {open &&
        group.containers.map((c) => (
          <ContainerRow
            key={c.id}
            c={c}
            ncpu={ncpu}
            memTotalBytes={memTotalBytes}
            history={history?.get(c.id)}
          />
        ))}
    </>
  );
}

function ContainerTable({
  snapshot,
  extras,
}: {
  snapshot: MetricsSnapshot;
  extras: MonitorExtras;
}) {
  const groups = useMemo(
    () => groupByProject(snapshot.containers),
    [snapshot.containers],
  );

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 1 }}>
        Per container (our infra only)
      </Typography>
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Profile / Service</TableCell>
              <TableCell>State</TableCell>
              <TableCell>CPU</TableCell>
              <TableCell>Memory</TableCell>
              <TableCell align="right">Network</TableCell>
              <TableCell align="right">Disk I/O</TableCell>
              <TableCell align="right">PIDs</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {groups.map((g) => (
              <GroupBlock
                key={g.project}
                group={g}
                ncpu={snapshot.host.ncpu}
                memTotalBytes={snapshot.host.memTotalBytes}
                extras={extras}
              />
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

export function ResourceMonitor({
  snapshot,
  ...extras
}: { snapshot: MetricsSnapshot } & MonitorExtras) {
  return (
    <Stack spacing={3}>
      <HostSection host={snapshot.host} infra={snapshot.infra} />
      <OutsideSection
        host={snapshot.host}
        infra={snapshot.infra}
        outside={snapshot.outside}
      />
      <InfraSummary infra={snapshot.infra} host={snapshot.host} />
      <ContainerTable snapshot={snapshot} extras={extras} />
    </Stack>
  );
}
