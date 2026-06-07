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
  /** Aggregate host CPU usage across all cores, 0–100. null when /host/proc is unavailable. */
  cpuPercent: number | null;
  /** Number of logical cores. */
  ncpu: number;
  /** RAM in use (total - available), bytes. null when unavailable. */
  memUsedBytes: number | null;
  /** Total physical RAM, bytes. */
  memTotalBytes: number;
  /** Disk used on the host root filesystem, bytes. null when unavailable. */
  diskUsedBytes: number | null;
  /** Total size of the host root filesystem, bytes. null when unavailable. */
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
  /** com.docker.compose.project label → the profile a container belongs to. */
  project: string | null;
  /** com.docker.compose.service label → the service within the profile. */
  service: string | null;
  /** Docker container state, e.g. "running". */
  state: string;
  /** CPU usage as a share of one core × 100 (so 250 = 2.5 cores). */
  cpuPercent: number;
  memUsageBytes: number;
  memLimitBytes: number;
  /** memUsageBytes / memLimitBytes × 100. */
  memPercent: number;
  /** Cumulative bytes received/sent since the container started. */
  netRxBytes: number;
  netTxBytes: number;
  /** Throughput over the last sample interval, bytes/second. */
  netRxRate: number;
  netTxRate: number;
  /** Cumulative block I/O since the container started. */
  blkReadBytes: number;
  blkWriteBytes: number;
  /** Block I/O over the last sample interval, bytes/second. */
  blkReadRate: number;
  blkWriteRate: number;
  /** Number of processes/threads in the container. */
  pids: number;
}

export interface InfraTotals {
  /** Sum of every container's cpuPercent. */
  cpuPercent: number;
  /** Sum of every container's memUsageBytes. */
  memUsageBytes: number;
  /** Sum of cumulative network bytes across containers. */
  netRxBytes: number;
  netTxBytes: number;
  /** Sum of every container's network throughput, bytes/second. */
  netRxRate: number;
  netTxRate: number;
  /** Sum of cumulative block I/O across containers. */
  blkReadBytes: number;
  blkWriteBytes: number;
  /** Sum of every container's block I/O throughput, bytes/second. */
  blkReadRate: number;
  blkWriteRate: number;
  /** Number of containers included in the totals. */
  containerCount: number;
}

export interface MetricsSnapshot {
  /** ISO-8601 timestamp of when the sample was taken. */
  timestamp: string;
  host: HostMetrics;
  infra: InfraTotals;
  /** Host minus our infra (CPU + memory; see OutsideTotals). */
  outside: OutsideTotals;
  containers: ContainerMetrics[];
}
