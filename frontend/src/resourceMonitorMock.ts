import type { ContainerMetrics, MetricsSnapshot } from './types';

/**
 * Synthetic snapshot used to review the Resources layout before wiring live
 * data. Numbers are made up but plausible for the current system: two profiles
 * (streamer1, viewer1) plus the manager's own stack, on an 8-core / 32 GB box.
 */

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const KB = 1024;

function mk(
  project: string,
  service: string,
  partial: Partial<ContainerMetrics>,
): ContainerMetrics {
  return {
    id: `${project}-${service}`.padEnd(12, '0'),
    name: `${project}-${service}-1`,
    project,
    service,
    state: 'running',
    cpuPercent: 0,
    memUsageBytes: 0,
    memLimitBytes: 2 * GB,
    memPercent: 0,
    netRxBytes: 0,
    netTxBytes: 0,
    netRxRate: 0,
    netTxRate: 0,
    blkReadBytes: 0,
    blkWriteBytes: 0,
    blkReadRate: 0,
    blkWriteRate: 0,
    pids: 0,
    ...partial,
  };
}

const CONTAINERS: ContainerMetrics[] = [
  // streamer1
  mk('streamer1', 'srs', {
    cpuPercent: 72.4,
    memUsageBytes: 256 * MB,
    memLimitBytes: 2 * GB,
    memPercent: 12.5,
    netRxRate: 5 * KB,
    netTxRate: 10 * KB,
    blkWriteRate: 2 * KB,
    pids: 14,
  }),
  mk('streamer1', 'stream-uploader', {
    cpuPercent: 18.2,
    memUsageBytes: 90 * MB,
    memLimitBytes: 1 * GB,
    memPercent: 8.8,
    netRxRate: 2 * KB,
    netTxRate: 50 * KB,
    pids: 8,
  }),
  mk('streamer1', 'bee-uploader', {
    cpuPercent: 33.1,
    memUsageBytes: 410 * MB,
    memLimitBytes: 4 * GB,
    memPercent: 10.0,
    netRxRate: 100 * KB,
    netTxRate: 80 * KB,
    blkReadRate: 4 * KB,
    blkWriteRate: 8 * KB,
    pids: 22,
  }),
  // viewer1
  mk('viewer1', 'client', {
    cpuPercent: 2.1,
    memUsageBytes: 30 * MB,
    memLimitBytes: 512 * MB,
    memPercent: 5.9,
    netRxRate: 8 * KB,
    netTxRate: 4 * KB,
    pids: 5,
  }),
  mk('viewer1', 'bee-gateway', {
    cpuPercent: 27.6,
    memUsageBytes: 380 * MB,
    memLimitBytes: 4 * GB,
    memPercent: 9.3,
    netRxRate: 80 * KB,
    netTxRate: 60 * KB,
    pids: 20,
  }),
  // manager's own stack
  mk('streaming-infra-manager', 'api', {
    cpuPercent: 4.5,
    memUsageBytes: 120 * MB,
    memLimitBytes: 32 * GB,
    memPercent: 0.4,
    netRxRate: 1 * KB,
    netTxRate: 2 * KB,
    pids: 18,
  }),
  mk('streaming-infra-manager', 'postgres', {
    cpuPercent: 1.2,
    memUsageBytes: 80 * MB,
    memLimitBytes: 32 * GB,
    memPercent: 0.25,
    pids: 12,
  }),
  mk('streaming-infra-manager', 'web', {
    cpuPercent: 0.3,
    memUsageBytes: 12 * MB,
    memLimitBytes: 32 * GB,
    memPercent: 0.04,
    pids: 6,
  }),
];

const infra = CONTAINERS.reduce(
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

export const MOCK_SNAPSHOT: MetricsSnapshot = {
  timestamp: '2026-06-07T14:30:00.000Z',
  host: {
    cpuPercent: 28.5,
    ncpu: 8,
    memUsedBytes: 9 * GB,
    memTotalBytes: 32 * GB,
    diskUsedBytes: 82 * GB,
    diskTotalBytes: 512 * GB,
  },
  infra,
  containers: CONTAINERS,
};
