/**
 * The fake host and container metrics: one snapshot on demand, and a stream of
 * them for anything watching.
 *
 * The counters below are cumulative on purpose. The frontend derives rates from
 * the difference between two snapshots, so a counter that reset each time would
 * read as a host doing nothing.
 */
import { randomInt } from 'node:crypto';

import { CPU_BY_SERVICE, GB, MEM_BY_SERVICE, state } from './mock-seed.mjs';

const METRICS_INTERVAL_MS = 2_000;

export const metricsClients = new Set();
let netRx = 0;
let netTx = 0;
let blkRead = 0;
let blkWrite = 0;

function jitter(base, spread) {
  return Number((base + Math.random() * spread).toFixed(2));
}

export function metricsSnapshot() {
  const ncpu = 8;
  const memTotalBytes = 32 * GB;
  const containers = [];

  for (const profile of state.profiles) {
    for (const container of profile.containers) {
      const cpu = jitter(CPU_BY_SERVICE[container.service] ?? 4, 6);
      const mem = (MEM_BY_SERVICE[container.service] ?? 120) * 1024 * 1024;
      containers.push({
        id: `${profile.name}-${container.service}`,
        name: `${profile.name}-${container.service}-1`,
        project: profile.name,
        service: container.service,
        state: 'running',
        cpuPercent: cpu,
        memUsageBytes: Math.round(mem * (0.8 + Math.random() * 0.4)),
        memLimitBytes: 2 * GB,
        memPercent: Number(((mem / (2 * GB)) * 100).toFixed(2)),
        netRxBytes: Math.round(Math.random() * 4 * GB),
        netTxBytes: Math.round(Math.random() * 12 * GB),
        netRxRate: jitter(900_000, 400_000),
        netTxRate: jitter(3_200_000, 900_000),
        blkReadBytes: Math.round(Math.random() * GB),
        blkWriteBytes: Math.round(Math.random() * 6 * GB),
        blkReadRate: jitter(300_000, 200_000),
        blkWriteRate: jitter(2_100_000, 800_000),
        pids: randomInt(6, 40),
      });
    }
  }

  const infraCpu = containers.reduce((sum, c) => sum + c.cpuPercent, 0);
  const infraMem = containers.reduce((sum, c) => sum + c.memUsageBytes, 0);
  const hostCpuPercent = Math.min(
    92,
    Number((infraCpu / ncpu + 8 + Math.random() * 6).toFixed(1)),
  );
  const memUsedBytes = infraMem + 11 * GB;

  netRx += 9_000_000;
  netTx += 40_000_000;
  blkRead += 2_000_000;
  blkWrite += 20_000_000;

  return {
    timestamp: new Date().toISOString(),
    host: {
      cpuPercent: hostCpuPercent,
      ncpu,
      memUsedBytes,
      memTotalBytes,
      diskUsedBytes: 212 * GB,
      diskTotalBytes: 500 * GB,
      netRxBytes: netRx,
      netTxBytes: netTx,
      netRxRate: jitter(12_000_000, 3_000_000),
      netTxRate: jitter(48_000_000, 8_000_000),
      diskReadBytes: blkRead,
      diskWriteBytes: blkWrite,
      diskReadRate: jitter(3_100_000, 900_000),
      diskWriteRate: jitter(22_000_000, 4_000_000),
    },
    infra: {
      cpuPercent: Number(infraCpu.toFixed(2)),
      memUsageBytes: infraMem,
      netRxBytes: Math.round(netRx * 0.8),
      netTxBytes: Math.round(netTx * 0.9),
      netRxRate: jitter(9_800_000, 2_000_000),
      netTxRate: jitter(44_000_000, 6_000_000),
      blkReadBytes: Math.round(blkRead * 0.7),
      blkWriteBytes: Math.round(blkWrite * 0.95),
      blkReadRate: jitter(2_000_000, 600_000),
      blkWriteRate: jitter(21_100_000, 3_000_000),
      containerCount: containers.length,
    },
    outside: {
      cpuPercent: Number(
        Math.max(0, hostCpuPercent * ncpu - infraCpu).toFixed(2),
      ),
      memUsageBytes: memUsedBytes - infraMem,
    },
    containers,
  };
}

setInterval(() => {
  if (metricsClients.size === 0) return;
  const frame = `event: snapshot\ndata: ${JSON.stringify(metricsSnapshot())}\n\n`;
  for (const client of metricsClients) client.write(frame);
}, METRICS_INTERVAL_MS);
