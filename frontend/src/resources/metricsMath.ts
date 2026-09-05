import type { MetricsSnapshot } from '../types';

/** One resource as two shares of the whole machine, plus the raw numbers. */
export interface ResourceShare {
  /** What this manager's own stacks use, as a fraction of the machine. */
  ours: number;
  /** Everything else on the machine, as a fraction. Never negative. */
  other: number;
}

export interface HostShares {
  cpu: ResourceShare;
  memory: ResourceShare;
  disk: ResourceShare;
}

/**
 * The three bars the Overview and the Host page both draw.
 *
 * Disk is attributed entirely to "everything else": the host figure is the
 * whole root filesystem, and a deployment's own data size is a separate,
 * on-demand lookup rather than a slice of it.
 */
export function hostShares(snapshot: MetricsSnapshot): HostShares {
  const { host, infra } = snapshot;

  const cpuOurs = cpuFractionOfHost(infra.cpuPercent, host.ncpu);
  const cpuHost = fractionOf(host.cpuPercent, 100);
  const memOurs = fractionOf(infra.memUsageBytes, host.memTotalBytes);
  const memHost = fractionOf(host.memUsedBytes, host.memTotalBytes);
  const diskHost = fractionOf(host.diskUsedBytes, host.diskTotalBytes);

  return {
    cpu: { ours: cpuOurs, other: Math.max(0, cpuHost - cpuOurs) },
    memory: { ours: memOurs, other: Math.max(0, memHost - memOurs) },
    disk: { ours: 0, other: diskHost },
  };
}

export function fractionOf(
  used: number | null | undefined,
  total: number | null | undefined,
): number {
  if (used == null || total == null || total <= 0) return 0;
  return used / total;
}

export function cpuFractionOfHost(
  cpuCorePercent: number,
  ncpu: number,
): number {
  return ncpu > 0 ? cpuCorePercent / 100 / ncpu : 0;
}

