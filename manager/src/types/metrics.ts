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
  /** Sum of every container's network throughput, bytes/second. */
  netRxRate: number;
  netTxRate: number;
  /** Number of containers included in the totals. */
  containerCount: number;
}

export interface MetricsSnapshot {
  /** ISO-8601 timestamp of when the sample was taken. */
  timestamp: string;
  host: HostMetrics;
  infra: InfraTotals;
  containers: ContainerMetrics[];
}
