/** How often the manager takes a resource sample, and so how often one arrives. */
export const METRICS_SAMPLE_INTERVAL_MS = 2000;

// Resource snapshot shared by the manager API and the frontend.
// Bytes are absolute; *Rate fields are bytes/second between samples.
// host.cpuPercent is 0–100 for the whole box; container/infra cpuPercent is
// share-of-one-core × 100 (an 8-core box tops out at 800).

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

// Host minus our infra — only CPU and memory subtract exactly; network and
// disk I/O are measured at different points and are shown side by side instead.
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
  /**
   * How many times the daemon has restarted this container.
   *
   * A container that dies and comes back reads as "running" between its
   * restarts, which is how a Bee node that had never been funded sat in a
   * restart loop on the live host for six days, 2,760 times, while every page
   * called it running. Read on a slower cadence than the rest of this row,
   * because it changes in minutes and the rest changes in seconds.
   */
  restartCount: number;
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
