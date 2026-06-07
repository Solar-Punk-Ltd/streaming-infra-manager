/**
 * Mirror of the manager's metrics snapshot (manager/src/types/metrics.ts).
 * Three nested layers: host (whole box) → infra (sum of our containers) →
 * containers (each instance, grouped by compose project = profile).
 */

export interface HostMetrics {
  cpuPercent: number | null;
  ncpu: number;
  memUsedBytes: number | null;
  memTotalBytes: number;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
  netRxRate: number | null;
  netTxRate: number | null;
  diskReadBytes: number | null;
  diskWriteBytes: number | null;
  diskReadRate: number | null;
  diskWriteRate: number | null;
}

/** Host minus our infra (exact for CPU + memory only; see MetricsSnapshot). */
export interface OutsideTotals {
  cpuPercent: number | null;
  memUsageBytes: number | null;
}

export interface ContainerMetrics {
  id: string;
  name: string;
  project: string | null;
  service: string | null;
  state: string;
  cpuPercent: number;
  memUsageBytes: number;
  memLimitBytes: number;
  memPercent: number;
  netRxBytes: number;
  netTxBytes: number;
  netRxRate: number;
  netTxRate: number;
  blkReadBytes: number;
  blkWriteBytes: number;
  blkReadRate: number;
  blkWriteRate: number;
  pids: number;
}

export interface InfraTotals {
  cpuPercent: number;
  memUsageBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  netRxRate: number;
  netTxRate: number;
  blkReadBytes: number;
  blkWriteBytes: number;
  blkReadRate: number;
  blkWriteRate: number;
  containerCount: number;
}

export interface MetricsSnapshot {
  timestamp: string;
  host: HostMetrics;
  infra: InfraTotals;
  outside: OutsideTotals;
  containers: ContainerMetrics[];
}
