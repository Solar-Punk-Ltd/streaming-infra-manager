import { useCallback, useRef, useState } from 'react';
import { Box, CircularProgress, Stack, Typography } from '@mui/material';

import { SectionCard } from '../components/SectionCard';
import { formatBytes, formatRate } from '../format';
import { useMetrics } from '../useMetrics';
import { ContainerTable } from './ContainerTable';
import { HostBars, HostLegend } from './HostBars';
import { StatCard } from './StatCard';

/**
 * The whole machine, then what this manager put on it.
 *
 * Subscribing to the metrics stream is also what makes the manager sample
 * Docker at all, so it only runs while this page is open.
 */
export function HostPage() {
  const { snapshot, history, connected, fetchProfileDiskBytes } = useMetrics();
  const [diskByProject, setDiskByProject] = useState<Map<string, number | null>>(
    new Map(),
  );
  const requested = useRef<Set<string>>(new Set());

  const onExpandProject = useCallback(
    (project: string) => {
      if (requested.current.has(project)) return;
      requested.current.add(project);
      void fetchProfileDiskBytes(project).then((size) =>
        setDiskByProject((prev) => new Map(prev).set(project, size)),
      );
    },
    [fetchProfileDiskBytes],
  );

  if (!snapshot) {
    return (
      <Stack alignItems="center" spacing={2} sx={{ py: 8 }}>
        <CircularProgress />
        <Typography variant="body2" color="text.secondary">
          {connected
            ? 'Waiting for the first sample…'
            : 'Connecting to the metrics stream…'}
        </Typography>
      </Stack>
    );
  }

  const { host, infra } = snapshot;

  return (
    <Stack spacing={2}>
      <HostBars snapshot={snapshot} />

      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
        }}
      >
        <StatCard
          title="Network now"
          value={`↓ ${formatRate(host.netRxRate)} · ↑ ${formatRate(host.netTxRate)}`}
          sub={`our stacks ↓ ${formatRate(infra.netRxRate)} · ↑ ${formatRate(infra.netTxRate)}`}
        />
        <StatCard
          title="Disk I/O now"
          value={`R ${formatRate(host.diskReadRate)} · W ${formatRate(host.diskWriteRate)}`}
          sub={`our stacks R ${formatRate(infra.blkReadRate)} · W ${formatRate(infra.blkWriteRate)}`}
        />
      </Box>

      <HostLegend />

      <SectionCard
        title="Per deployment"
        sub={`containers this manager started · ${formatBytes(infra.memUsageBytes)} of memory in ${infra.containerCount} containers`}
        flush
      >
        <ContainerTable
          snapshot={snapshot}
          history={history}
          diskByProject={diskByProject}
          onExpandProject={onExpandProject}
        />
      </SectionCard>
    </Stack>
  );
}
