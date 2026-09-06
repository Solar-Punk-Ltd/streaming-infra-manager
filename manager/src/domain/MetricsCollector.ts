import {
  getErrorMessage,
  METRICS_SAMPLE_INTERVAL_MS,
} from '@streaming-infra-manager/common';
import Docker from 'dockerode';

import {
  ContainerMetrics,
  HostMetrics,
  InfraTotals,
  MetricsSnapshot,
  OutsideTotals,
} from '../types/index.js';

import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_SERVICE_LABEL,
} from './composeLabels.js';
import { answeredInTime, DOCKER_TIMEOUT_MS } from './dockerTimeout.js';
import { HostCollector } from './HostCollector.js';
import { Logger } from './Logger.js';

const logger = Logger.getInstance();

type Listener = (snapshot: MetricsSnapshot) => void;

type ManagedProjectsProvider = () => Promise<Set<string>>;

/** The one call this makes on a container. */
export interface StatsHandle {
  stats(options: { stream: false }): Promise<Docker.ContainerStats>;
}

/**
 * The slice of dockerode this reads.
 *
 * Named so a test can hand over a double without standing up a Docker daemon.
 */
export interface MetricsDockerEngine {
  listContainers(
    options: Docker.ContainerListOptions,
  ): Promise<Docker.ContainerInfo[]>;
  getContainer(id: string): StatsHandle;
}

/** Where the host numbers come from, so a test can supply its own. */
export interface HostSampler {
  sample(): Promise<HostMetrics>;
}

interface PrevCounters {
  netRxBytes: number;
  netTxBytes: number;
  blkReadBytes: number;
  blkWriteBytes: number;
  readTimeMs: number;
}

export class MetricsCollector {
  private readonly listeners = new Set<Listener>();
  private readonly prev = new Map<string, PrevCounters>();
  private timer: NodeJS.Timeout | null = null;
  private latest: MetricsSnapshot | null = null;
  private samplingStartedAt: number | null = null;
  private managedProjects: ManagedProjectsProvider | null = null;
  private lastManagedProjects: Set<string> | null = null;

  constructor(
    private readonly docker: MetricsDockerEngine = new Docker({
      timeout: DOCKER_TIMEOUT_MS,
    }),
    private readonly host: HostSampler = new HostCollector(),
    private readonly intervalMs: number = METRICS_SAMPLE_INTERVAL_MS,
    private readonly dockerTimeoutMs: number = DOCKER_TIMEOUT_MS,
  ) {}

  setManagedProjectsProvider(provider: ManagedProjectsProvider): void {
    this.managedProjects = provider;
  }

  getLatest(): MetricsSnapshot | null {
    return this.latest;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.start();
    if (this.latest) listener(this.latest);

    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  start(): void {
    if (this.timer) return;
    logger.info('[MetricsCollector] sampling started');
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('[MetricsCollector] sampling stopped');
    }
    this.samplingStartedAt = null;
    this.prev.clear();
  }

  /**
   * One sample, and only one at a time.
   *
   * The sample in flight blocks the next tick, but only until it is past the
   * deadline every call inside it already carries. Otherwise anything that
   * never settles would end sampling for the life of the process, and the
   * resource cards would sit on old numbers through the failure they exist to
   * show.
   */
  private async tick(): Promise<void> {
    const startedAt = Date.now();
    const inFlightSince = this.samplingStartedAt;
    if (inFlightSince !== null) {
      const runningForMs = startedAt - inFlightSince;
      if (runningForMs < this.dockerTimeoutMs) return;
      logger.warn(
        `[MetricsCollector] previous sample abandoned after ${runningForMs}ms`,
      );
    }

    this.samplingStartedAt = startedAt;
    try {
      const snapshot = await this.collect();
      this.latest = snapshot;
      for (const listener of this.listeners) {
        try {
          listener(snapshot);
        } catch (err) {
          logger.warn(
            `[MetricsCollector] listener threw: ${getErrorMessage(err)}`,
          );
        }
      }
    } catch (err) {
      logger.warn(`[MetricsCollector] sample failed: ${getErrorMessage(err)}`);
    } finally {
      // An abandoned sample may still settle, long after a later one took over.
      if (this.samplingStartedAt === startedAt) this.samplingStartedAt = null;
    }
  }

  private async collect(): Promise<MetricsSnapshot> {
    const [host, containers] = await Promise.all([
      this.host.sample(),
      this.collectContainers(),
    ]);

    const infra = aggregateInfra(containers);
    return {
      timestamp: new Date().toISOString(),
      host,
      infra,
      outside: computeOutside(host, infra),
      containers,
    };
  }

  private async collectContainers(): Promise<ContainerMetrics[]> {
    const list = await answeredInTime(
      this.docker.listContainers({ all: false }),
      this.dockerTimeoutMs,
    );

    const managed = await this.resolveManagedProjects();
    const scoped = managed
      ? list.filter((info) => {
          const project = info.Labels?.[COMPOSE_PROJECT_LABEL];
          return !!project && managed.has(project);
        })
      : list;

    const liveIds = new Set(scoped.map((info) => info.Id));
    for (const id of this.prev.keys()) {
      if (!liveIds.has(id)) this.prev.delete(id);
    }

    const results = await Promise.all(
      scoped.map((info) => this.statContainer(info)),
    );
    return results.filter((c): c is ContainerMetrics => c !== null);
  }

  private async resolveManagedProjects(): Promise<Set<string> | null> {
    if (!this.managedProjects) return null;
    try {
      const set = await this.managedProjects();
      this.lastManagedProjects = set;
      return set;
    } catch (err) {
      logger.warn(
        `[MetricsCollector] could not resolve managed projects: ${getErrorMessage(err)}`,
      );
      return this.lastManagedProjects;
    }
  }

  private async statContainer(
    info: Docker.ContainerInfo,
  ): Promise<ContainerMetrics | null> {
    try {
      const stats = await answeredInTime(
        this.docker.getContainer(info.Id).stats({ stream: false }),
        this.dockerTimeoutMs,
      );
      return this.toMetrics(info, stats);
    } catch (err) {
      logger.debug(
        `[MetricsCollector] stats failed for ${info.Id.slice(0, 12)}: ${getErrorMessage(err)}`,
      );
      return null;
    }
  }

  private toMetrics(
    info: Docker.ContainerInfo,
    stats: Docker.ContainerStats,
  ): ContainerMetrics {
    const cpuPercent = computeCpuPercent(stats);
    const { memUsageBytes, memLimitBytes, memPercent } = computeMemory(stats);
    const { netRxBytes, netTxBytes } = sumNetwork(stats);
    const { blkReadBytes, blkWriteBytes } = sumBlockIo(stats);

    const readTimeMs = Date.parse(stats.read);
    const rates = this.computeRates(info.Id, {
      netRxBytes,
      netTxBytes,
      blkReadBytes,
      blkWriteBytes,
      readTimeMs,
    });

    return {
      id: info.Id,
      name: info.Names?.[0]?.replace(/^\//, '') ?? info.Id.slice(0, 12),
      project: info.Labels?.[COMPOSE_PROJECT_LABEL] ?? null,
      service: info.Labels?.[COMPOSE_SERVICE_LABEL] ?? null,
      state: info.State ?? 'unknown',
      cpuPercent,
      memUsageBytes,
      memLimitBytes,
      memPercent,
      netRxBytes,
      netTxBytes,
      blkReadBytes,
      blkWriteBytes,
      pids: stats.pids_stats?.current ?? 0,
      ...rates,
    };
  }

  private computeRates(
    id: string,
    cur: PrevCounters,
  ): {
    netRxRate: number;
    netTxRate: number;
    blkReadRate: number;
    blkWriteRate: number;
  } {
    const prev = this.prev.get(id);
    this.prev.set(id, cur);

    if (!prev) {
      return { netRxRate: 0, netTxRate: 0, blkReadRate: 0, blkWriteRate: 0 };
    }

    const elapsedSec = (cur.readTimeMs - prev.readTimeMs) / 1000;
    if (!Number.isFinite(elapsedSec) || elapsedSec <= 0) {
      return { netRxRate: 0, netTxRate: 0, blkReadRate: 0, blkWriteRate: 0 };
    }

    const rate = (now: number, before: number): number =>
      Math.max(0, (now - before) / elapsedSec);

    return {
      netRxRate: rate(cur.netRxBytes, prev.netRxBytes),
      netTxRate: rate(cur.netTxBytes, prev.netTxBytes),
      blkReadRate: rate(cur.blkReadBytes, prev.blkReadBytes),
      blkWriteRate: rate(cur.blkWriteBytes, prev.blkWriteBytes),
    };
  }
}

function computeCpuPercent(stats: Docker.ContainerStats): number {
  // docker CLI formula; the first read has no precpu baseline, so report 0.
  if (!stats.precpu_stats.system_cpu_usage) return 0;

  const cpuDelta =
    stats.cpu_stats.cpu_usage.total_usage -
    (stats.precpu_stats.cpu_usage?.total_usage ?? 0);
  const systemDelta =
    stats.cpu_stats.system_cpu_usage -
    (stats.precpu_stats.system_cpu_usage ?? 0);
  const onlineCpus =
    stats.cpu_stats.online_cpus ||
    stats.cpu_stats.cpu_usage.percpu_usage?.length ||
    1;

  if (systemDelta <= 0 || cpuDelta <= 0) return 0;
  return (cpuDelta / systemDelta) * onlineCpus * 100;
}

function computeMemory(stats: Docker.ContainerStats): {
  memUsageBytes: number;
  memLimitBytes: number;
  memPercent: number;
} {
  const rawUsage = stats.memory_stats.usage ?? 0;
  // Subtract page cache (cgroup v2 inactive_file / v1 cache) to match docker stats.
  const sub = stats.memory_stats.stats as Record<string, number> | undefined;
  const cache =
    sub?.inactive_file ?? sub?.total_inactive_file ?? sub?.cache ?? 0;
  const memUsageBytes = Math.max(0, rawUsage - cache);
  const memLimitBytes = stats.memory_stats.limit ?? 0;
  const memPercent =
    memLimitBytes > 0 ? (memUsageBytes / memLimitBytes) * 100 : 0;
  return { memUsageBytes, memLimitBytes, memPercent };
}

function sumNetwork(stats: Docker.ContainerStats): {
  netRxBytes: number;
  netTxBytes: number;
} {
  let netRxBytes = 0;
  let netTxBytes = 0;
  for (const iface of Object.values(stats.networks ?? {})) {
    netRxBytes += iface.rx_bytes ?? 0;
    netTxBytes += iface.tx_bytes ?? 0;
  }
  return { netRxBytes, netTxBytes };
}

function sumBlockIo(stats: Docker.ContainerStats): {
  blkReadBytes: number;
  blkWriteBytes: number;
} {
  let blkReadBytes = 0;
  let blkWriteBytes = 0;
  for (const entry of stats.blkio_stats?.io_service_bytes_recursive ?? []) {
    const op = entry.op?.toLowerCase();
    if (op === 'read') blkReadBytes += entry.value ?? 0;
    else if (op === 'write') blkWriteBytes += entry.value ?? 0;
  }
  return { blkReadBytes, blkWriteBytes };
}

// host.cpuPercent is 0–100 for the whole box; ×ncpu puts it on infra's core×100 scale.
function computeOutside(host: HostMetrics, infra: InfraTotals): OutsideTotals {
  return {
    cpuPercent:
      host.cpuPercent != null
        ? Math.max(0, host.cpuPercent * host.ncpu - infra.cpuPercent)
        : null,
    memUsageBytes:
      host.memUsedBytes != null
        ? Math.max(0, host.memUsedBytes - infra.memUsageBytes)
        : null,
  };
}

function aggregateInfra(containers: ContainerMetrics[]): InfraTotals {
  return containers.reduce<InfraTotals>(
    (acc, c) => ({
      cpuPercent: acc.cpuPercent + c.cpuPercent,
      memUsageBytes: acc.memUsageBytes + c.memUsageBytes,
      netRxBytes: acc.netRxBytes + c.netRxBytes,
      netTxBytes: acc.netTxBytes + c.netTxBytes,
      netRxRate: acc.netRxRate + c.netRxRate,
      netTxRate: acc.netTxRate + c.netTxRate,
      blkReadBytes: acc.blkReadBytes + c.blkReadBytes,
      blkWriteBytes: acc.blkWriteBytes + c.blkWriteBytes,
      blkReadRate: acc.blkReadRate + c.blkReadRate,
      blkWriteRate: acc.blkWriteRate + c.blkWriteRate,
      containerCount: acc.containerCount + 1,
    }),
    {
      cpuPercent: 0,
      memUsageBytes: 0,
      netRxBytes: 0,
      netTxBytes: 0,
      netRxRate: 0,
      netTxRate: 0,
      blkReadBytes: 0,
      blkWriteBytes: 0,
      blkReadRate: 0,
      blkWriteRate: 0,
      containerCount: 0,
    },
  );
}
