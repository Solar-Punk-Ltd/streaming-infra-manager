import { useMemo, useState } from 'react';
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
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';

import { formatBytes, formatCores, formatPercent, formatRate } from './format';
import type {
  ContainerMetrics,
  HostMetrics,
  InfraTotals,
  MetricsSnapshot,
} from './types';

const INFRA_COLOR = 'primary.main';
const OTHER_COLOR = 'rgba(255,255,255,0.22)';

interface Segment {
  fraction: number;
  color: string;
}

/** Horizontal stacked bar; segments are fractions (0–1) of the full width. */
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
      <LegendItem color={OTHER_COLOR} label="Other host usage" />
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

  // Disk — host only (we don't track our stack's on-disk footprint here).
  const diskFrac =
    host.diskUsedBytes != null && host.diskTotalBytes
      ? host.diskUsedBytes / host.diskTotalBytes
      : 0;
  const diskSegments: Segment[] = [{ fraction: diskFrac, color: OTHER_COLOR }];

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 1 }}>
        Host
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
          footnote={`Our infra: ${formatCores(infra.cpuPercent)} cores (${formatPercent(
            infraCpuFrac * 100,
          )} of host)`}
        />
        <HostCard
          title="Memory"
          headline={formatPercent(hostMemFrac * 100)}
          sub={`${formatBytes(host.memUsedBytes)} / ${formatBytes(host.memTotalBytes)}`}
          segments={memSegments}
          footnote={`Our infra: ${formatBytes(infra.memUsageBytes)} (${formatPercent(
            infraMemFrac * 100,
          )} of host)`}
        />
        <HostCard
          title="Disk"
          headline={formatPercent(diskFrac * 100)}
          sub={`${formatBytes(host.diskUsedBytes)} / ${formatBytes(host.diskTotalBytes)}`}
          segments={diskSegments}
          footnote="Whole root filesystem"
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
  const cpuOfHost = host.ncpu > 0 ? infra.cpuPercent / host.ncpu : 0;
  const memOfHost = host.memTotalBytes
    ? (infra.memUsageBytes / host.memTotalBytes) * 100
    : 0;
  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 1 }}>
        Our infra
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, 1fr)' },
          gap: 2,
        }}
      >
        <StatCard
          title="CPU"
          value={`${formatCores(infra.cpuPercent)} cores`}
          sub={`${formatPercent(cpuOfHost)} of host`}
        />
        <StatCard
          title="Memory"
          value={formatBytes(infra.memUsageBytes)}
          sub={`${formatPercent(memOfHost)} of host`}
        />
        <StatCard
          title="Network"
          value={`↓ ${formatRate(infra.netRxRate)}`}
          sub={`↑ ${formatRate(infra.netTxRate)}`}
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
    .sort((a, b) => b.cpuPercent - a.cpuPercent);
}

function ContainerRow({ c, ncpu }: { c: ContainerMetrics; ncpu: number }) {
  const cpuBar = ncpu > 0 ? c.cpuPercent / ncpu : 0; // % of whole box
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
      <TableCell sx={{ minWidth: 120 }}>
        <Typography variant="body2">
          {formatCores(c.cpuPercent)} cores
        </Typography>
        <UsageBar
          segments={[{ fraction: cpuBar / 100, color: INFRA_COLOR }]}
          height={6}
        />
      </TableCell>
      <TableCell sx={{ minWidth: 140 }}>
        <Typography variant="body2">
          {formatBytes(c.memUsageBytes)} / {formatBytes(c.memLimitBytes)}
        </Typography>
        <UsageBar
          segments={[{ fraction: c.memPercent / 100, color: INFRA_COLOR }]}
          height={6}
        />
      </TableCell>
      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
        ↓ {formatRate(c.netRxRate)}
        <br />↑ {formatRate(c.netTxRate)}
      </TableCell>
      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
        R {formatRate(c.blkReadRate)}
        <br />W {formatRate(c.blkWriteRate)}
      </TableCell>
      <TableCell align="right">{c.pids}</TableCell>
    </TableRow>
  );
}

function GroupBlock({ group, ncpu }: { group: Group; ncpu: number }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <TableRow
        hover
        sx={{ cursor: 'pointer', '& td': { borderBottom: 'none' } }}
        onClick={() => setOpen((v) => !v)}
      >
        <TableCell colSpan={2}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <IconButton size="small">
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
          </Stack>
        </TableCell>
        <TableCell>
          <Typography variant="body2">
            {formatCores(group.cpuPercent)} cores
          </Typography>
        </TableCell>
        <TableCell>
          <Typography variant="body2">
            {formatBytes(group.memUsageBytes)}
          </Typography>
        </TableCell>
        <TableCell colSpan={3} />
      </TableRow>
      {open &&
        group.containers.map((c) => (
          <ContainerRow key={c.id} c={c} ncpu={ncpu} />
        ))}
    </>
  );
}

function ContainerTable({ snapshot }: { snapshot: MetricsSnapshot }) {
  const groups = useMemo(
    () => groupByProject(snapshot.containers),
    [snapshot.containers],
  );

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 1 }}>
        Per container
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
              <GroupBlock key={g.project} group={g} ncpu={snapshot.host.ncpu} />
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}

export function ResourceMonitor({ snapshot }: { snapshot: MetricsSnapshot }) {
  return (
    <Stack spacing={3}>
      <HostSection host={snapshot.host} infra={snapshot.infra} />
      <InfraSummary infra={snapshot.infra} host={snapshot.host} />
      <ContainerTable snapshot={snapshot} />
    </Stack>
  );
}
