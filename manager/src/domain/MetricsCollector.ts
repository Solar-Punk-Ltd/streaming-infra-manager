import { getErrorMessage } from '@streaming-infra-manager/common';
import Docker from 'dockerode';

import {
  ContainerMetrics,
  InfraTotals,
  MetricsSnapshot,
} from '../types/index.js';

import { HostCollector } from './HostCollector.js';
import { Logger } from './Logger.js';

const logger = Logger.getInstance();

const SAMPLE_INTERVAL_MS = 2000;
const PROJECT_LABEL = 'com.docker.compose.project';
const SERVICE_LABEL = 'com.docker.compose.service';

type Listener = (snapshot: MetricsSnapshot) => void;

/** Cumulative counters from the previous sample, used to derive per-second rates. */
interface PrevCounters {
  netRxBytes: number;
  netTxBytes: number;
  blkReadBytes: number;
  blkWriteBytes: number;
  readTimeMs: number;
}

/**
 * Samples Docker for per-container resource usage on an interval, combines it
 * with whole-host metrics, and fans the resulting snapshot out to subscribers
 * (the SSE route). Sampling is gated on demand: the interval only runs while at
 * least one subscriber is attached, so we never poll Docker when nobody is
 * watching.
 */
export class MetricsCollector {
  private readonly listeners = new Set<Listener>();
  private readonly prev = new Map<string, PrevCounters>();
  private timer: NodeJS.Timeout | null = null;
  private latest: MetricsSnapshot | null = null;
  private sampling = false;

  constructor(
    private readonly docker: Docker = new Docker(),
    private readonly host: HostCollector = new HostCollector(),
    private readonly intervalMs: number = SAMPLE_INTERVAL_MS,
  ) {}

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

  /** Begin sampling. Idempotent — safe to call on every new subscriber. */
  start(): void {
    if (this.timer) return;
    logger.info('[MetricsCollector] sampling started');
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  /** Stop sampling and forget rate baselines so the next start is clean. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('[MetricsCollector] sampling stopped');
    }
    this.prev.clear();
  }

  private async tick(): Promise<void> {
    // Skip if the previous sample is still in flight (slow Docker daemon).
    if (this.sampling) return;
    this.sampling = true;
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
      this.sampling = false;
    }
  }

  private async collect(): Promise<MetricsSnapshot> {
    const [host, containers] = await Promise.all([
      this.host.sample(),
      this.collectContainers(),
    ]);

    return {
      timestamp: new Date().toISOString(),
      host,
      infra: aggregateInfra(containers),
      containers,
    };
  }

  private async collectContainers(): Promise<ContainerMetrics[]> {
    const list = await this.docker.listContainers({ all: false });

    // Drop rate baselines for containers that are no longer running.
    const liveIds = new Set(list.map((info) => info.Id));
    for (const id of this.prev.keys()) {
      if (!liveIds.has(id)) this.prev.delete(id);
    }

    const results = await Promise.all(
      list.map((info) => this.statContainer(info)),
    );
    return results.filter((c): c is ContainerMetrics => c !== null);
  }

  private async statContainer(
    info: Docker.ContainerInfo,
  ): Promise<ContainerMetrics | null> {
    try {
      const stats = await this.docker
        .getContainer(info.Id)
        .stats({ stream: false });
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
      project: info.Labels?.[PROJECT_LABEL] ?? null,
      service: info.Labels?.[SERVICE_LABEL] ?? null,
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

  /** Derive per-second rates from the delta against the previous sample. */
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

/** CPU usage as a share of one core × 100, matching the docker CLI formula. */
function computeCpuPercent(stats: Docker.ContainerStats): number {
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
  // Exclude page cache so the number matches `docker stats`. cgroup v2 reports
  // inactive_file; v1 reports cache/total_inactive_file.
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

function aggregateInfra(containers: ContainerMetrics[]): InfraTotals {
  return containers.reduce<InfraTotals>(
    (acc, c) => ({
      cpuPercent: acc.cpuPercent + c.cpuPercent,
      memUsageBytes: acc.memUsageBytes + c.memUsageBytes,
      netRxRate: acc.netRxRate + c.netRxRate,
      netTxRate: acc.netTxRate + c.netTxRate,
      containerCount: acc.containerCount + 1,
    }),
    {
      cpuPercent: 0,
      memUsageBytes: 0,
      netRxRate: 0,
      netTxRate: 0,
      containerCount: 0,
    },
  );
}
