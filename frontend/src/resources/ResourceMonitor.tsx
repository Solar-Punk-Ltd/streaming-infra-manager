import { Stack } from '@mui/material';

import type { MetricsSnapshot } from '../types';
import { HostSection } from './HostSection';
import { OutsideSection } from './OutsideSection';
import { InfraSummary } from './InfraSummary';
import { ContainerTable } from './ContainerTable';

/** Optional live extras layered on top of the snapshot. */
export interface MonitorExtras {
  /** containerId → recent cpuPercent samples, for sparklines. */
  history?: Map<string, number[]>;
  /** project → on-disk footprint in bytes (null = none / not yet loaded). */
  diskByProject?: Map<string, number | null>;
  /** Called when a profile group is shown, to lazily load its disk size. */
  onExpandProject?: (project: string) => void;
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
