import { Stack } from '@mui/material';

import type { MetricsSnapshot } from '../types';
import type { CpuHistoryByContainer } from '../useMetrics';
import { HostSection } from './HostSection';
import { OutsideSection } from './OutsideSection';
import { InfraSummary } from './InfraSummary';
import { ContainerTable } from './ContainerTable';

export interface LiveMetricsProps {
  history?: CpuHistoryByContainer;
  diskByProject?: Map<string, number | null>;
  onExpandProject?: (project: string) => void;
}

export function ResourceMonitor({
  snapshot,
  history,
  diskByProject,
  onExpandProject,
}: { snapshot: MetricsSnapshot } & LiveMetricsProps) {
  return (
    <Stack spacing={3}>
      <HostSection host={snapshot.host} infra={snapshot.infra} />
      <OutsideSection
        host={snapshot.host}
        infra={snapshot.infra}
        outside={snapshot.outside}
      />
      <InfraSummary infra={snapshot.infra} host={snapshot.host} />
      <ContainerTable
        snapshot={snapshot}
        history={history}
        diskByProject={diskByProject}
        onExpandProject={onExpandProject}
      />
    </Stack>
  );
}
