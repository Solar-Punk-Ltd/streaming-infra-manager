/**
 * Real-time resource metrics. Three nested layers:
 *   host       — the whole box (CPU/RAM/disk), including non-Docker usage
 *   infra      — sum of all our containers (how much our stack occupies)
 *   containers — each running container, grouped by compose project (profile)
 *
 * All byte fields are absolute bytes; all *Rate fields are bytes/second
 * computed from deltas between samples; all *Percent fields are 0–100 where
 * CPU can exceed 100 (one full core = 100, so an 8-core box tops out at 800).
 */

export interface HostMetrics {
  cpuPercent: number | null;
  ncpu: number;
  memUsedBytes: number | null;
  memTotalBytes: number;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  /**
   * Whole-host network throughput (physical interfaces, excludes loopback and
   * docker/veth virtual links). Cumulative bytes since boot + per-second rate.
   * null when /host/proc/net/dev is unreadable; rates are 0 on the first sample.
   */
  netRxBytes: number | null;
  netTxBytes: number | null;
  netRxRate: number | null;
  netTxRate: number | null;
  /**
   * Whole-host disk I/O across physical block devices (from /proc/diskstats).
   * Cumulative bytes since boot + per-second rate. null when unreadable.
   */
  diskReadBytes: number | null;
  diskWriteBytes: number | null;
  diskReadRate: number | null;
  diskWriteRate: number | null;
}

/**
 * The host minus our infra. CPU and memory are an exact subtraction (our usage
 * is a strict subset of the host's). Network and disk I/O are NOT included here
 * — they can't be cleanly subtracted (container veth/blkio vs host NIC/diskstats
 * measure different points), so the UI shows host-vs-ours side by side instead.
 */
export interface OutsideTotals {
  /** host CPU − infra CPU, in share-of-one-core×100 (same scale as InfraTotals). null if host CPU unknown. */
  cpuPercent: number | null;
  /** host memory used − infra memory. null if host memory unknown. */
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
