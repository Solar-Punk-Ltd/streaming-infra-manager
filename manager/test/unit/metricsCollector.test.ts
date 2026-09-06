/**
 * The resource readings survive a Docker call that never answers.
 *
 * Unit test, no Docker daemon and no database. `pnpm test` in manager/.
 *
 * Both failures here are silent in production: the cards keep drawing the last
 * snapshot, and the stream keeps sending heartbeats, so a collector that has
 * stopped sampling looks exactly like a host where nothing is changing.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Docker from 'dockerode';

import {
  type HostSampler,
  type MetricsDockerEngine,
  MetricsCollector,
  type StatsHandle,
} from '../../src/domain/MetricsCollector.js';
import type { HostMetrics, MetricsSnapshot } from '../../src/types/index.js';

const DOCKER_TIMEOUT_MS = 40;

const HOST: HostMetrics = {
  cpuPercent: 10,
  ncpu: 4,
  memUsedBytes: 1_000,
  memTotalBytes: 8_000,
  diskUsedBytes: null,
  diskTotalBytes: null,
  netRxBytes: null,
  netTxBytes: null,
  netRxRate: null,
  netTxRate: null,
  diskReadBytes: null,
  diskWriteBytes: null,
  diskReadRate: null,
  diskWriteRate: null,
};

// Both Docker shapes carry dozens of required fields the collector never reads,
// so each fixture states the ones it does read and is cast once.
function containerInfo(name: string): Docker.ContainerInfo {
  return {
    Id: `id-${name}`,
    Names: [`/${name}`],
    State: 'running',
    Labels: {
      'com.docker.compose.project': 'deployment',
      'com.docker.compose.service': name,
    },
  } as unknown as Docker.ContainerInfo;
}

function containerStats(): Docker.ContainerStats {
  return {
    read: new Date().toISOString(),
    cpu_stats: {
      cpu_usage: { total_usage: 2_000 },
      system_cpu_usage: 20_000,
      online_cpus: 4,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 1_000 },
      system_cpu_usage: 10_000,
    },
    memory_stats: { usage: 500, limit: 1_000, stats: { inactive_file: 100 } },
    networks: {},
    blkio_stats: { io_service_bytes_recursive: [] },
    pids_stats: { current: 3 },
  } as unknown as Docker.ContainerStats;
}

const never = <T,>(): Promise<T> => new Promise<T>(() => undefined);

class FakeDockerEngine implements MetricsDockerEngine {
  constructor(
    private readonly containers: readonly Docker.ContainerInfo[],
    private readonly silentIds: ReadonlySet<string> = new Set(),
  ) {}

  listContainers(): Promise<Docker.ContainerInfo[]> {
    return Promise.resolve([...this.containers]);
  }

  getContainer(id: string): StatsHandle {
    const silent = this.silentIds.has(id);
    return { stats: () => (silent ? never() : Promise.resolve(containerStats())) };
  }
}

class FakeHost implements HostSampler {
  calls = 0;

  constructor(private readonly silentOnFirstCall = false) {}

  sample(): Promise<HostMetrics> {
    this.calls += 1;
    if (this.silentOnFirstCall && this.calls === 1) return never();
    return Promise.resolve(HOST);
  }
}

async function waitFor(
  ready: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('MetricsCollector', () => {
  it('leaves out a container whose stats never answer and samples again', async () => {
    const docker = new FakeDockerEngine(
      [containerInfo('srs'), containerInfo('wedged')],
      new Set(['id-wedged']),
    );
    const collector = new MetricsCollector(
      docker,
      new FakeHost(),
      DOCKER_TIMEOUT_MS * 3,
      DOCKER_TIMEOUT_MS,
    );

    const seen: MetricsSnapshot[] = [];
    const unsubscribe = collector.subscribe((snapshot) => seen.push(snapshot));

    try {
      await waitFor(() => seen.length >= 1, 1_000, 'the first snapshot');
      assert.deepEqual(
        seen[0].containers.map((container) => container.name),
        ['srs'],
      );
      assert.equal(seen[0].infra.containerCount, 1);

      await waitFor(() => seen.length >= 2, 1_000, 'the next snapshot');
    } finally {
      unsubscribe();
    }
  });

  it('takes over from a sample that never finishes', async () => {
    const host = new FakeHost(true);
    const collector = new MetricsCollector(
      new FakeDockerEngine([containerInfo('srs')]),
      host,
      DOCKER_TIMEOUT_MS / 2,
      DOCKER_TIMEOUT_MS,
    );

    const seen: MetricsSnapshot[] = [];
    const unsubscribe = collector.subscribe((snapshot) => seen.push(snapshot));

    try {
      await waitFor(() => seen.length >= 1, 1_000, 'a snapshot after the stuck one');
      assert.ok(host.calls >= 2, 'the stuck sample should not be the last one');
    } finally {
      unsubscribe();
    }
  });
});
