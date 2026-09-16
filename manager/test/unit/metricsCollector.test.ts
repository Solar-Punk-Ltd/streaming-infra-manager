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

/** Long enough to answer within the deadline one call carries, and not twice over. */
const SLOW_STATS_MS = 25;

const nine = (): Docker.ContainerInfo[] =>
  Array.from({ length: 9 }, (_unused, index) => containerInfo(`srs-${index}`));

/** Settles after the event loop has turned, so calls made together overlap. */
const soon = <T,>(value: T, afterMs: number): Promise<T> =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), afterMs));

class FakeDockerEngine implements MetricsDockerEngine {
  constructor(
    private readonly containers: readonly Docker.ContainerInfo[],
    private readonly silentIds: ReadonlySet<string> = new Set(),
    private readonly restartsById: ReadonlyMap<string, number> = new Map(),
    private readonly statsMs: number = 1,
  ) {}

  inspects = 0;

  /** One per sample, so a second sample started is a second list. */
  lists = 0;

  statsInFlight = 0;

  mostStatsInFlight = 0;

  listContainers(): Promise<Docker.ContainerInfo[]> {
    this.lists += 1;
    return Promise.resolve([...this.containers]);
  }

  getContainer(id: string): StatsHandle {
    const silent = this.silentIds.has(id);
    return {
      stats: async () => {
        this.statsInFlight += 1;
        this.mostStatsInFlight = Math.max(this.mostStatsInFlight, this.statsInFlight);
        try {
          return silent ? await never<Docker.ContainerStats>() : await soon(containerStats(), this.statsMs);
        } finally {
          this.statsInFlight -= 1;
        }
      },
      inspect: () => {
        this.inspects += 1;
        return Promise.resolve({ RestartCount: this.restartsById.get(id) ?? 0 } as Docker.ContainerInspectInfo);
      },
    };
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

  it('reports how often the daemon restarted a container, and asks again rarely', async () => {
    const docker = new FakeDockerEngine(
      [containerInfo('bee-uploader')],
      new Set(),
      new Map([['id-bee-uploader', 2760]]),
    );
    const collector = new MetricsCollector(docker, new FakeHost(), DOCKER_TIMEOUT_MS * 3, DOCKER_TIMEOUT_MS);

    const seen: MetricsSnapshot[] = [];
    const unsubscribe = collector.subscribe((snapshot) => seen.push(snapshot));

    try {
      await waitFor(() => seen.length >= 3, 2_000, 'three snapshots');
      assert.equal(seen[0].containers[0]?.restartCount, 2760);
      assert.equal(seen[2].containers[0]?.restartCount, 2760);
      assert.equal(docker.inspects, 1, 'a count that changes in minutes is not worth an inspect every sample');
    } finally {
      unsubscribe();
    }
  });

  it('asks the daemon about four containers at a time, whatever the sample covers', async () => {
    const docker = new FakeDockerEngine(nine());
    const collector = new MetricsCollector(docker, new FakeHost(), 1_000, DOCKER_TIMEOUT_MS * 10);

    const seen: MetricsSnapshot[] = [];
    const unsubscribe = collector.subscribe((snapshot) => seen.push(snapshot));

    try {
      await waitFor(() => seen.length >= 1, 2_000, 'the sample over nine containers');
      assert.equal(seen[0].containers.length, 9, 'every container is still sampled');
      assert.equal(
        docker.mostStatsInFlight,
        4,
        'twenty five containers must not mean twenty five calls at the daemon at once',
      );
    } finally {
      unsubscribe();
    }
  });

  /**
   * A sample of nine containers four at a time outlasts the deadline one call
   * carries, which is the shape a slow daemon puts every sample in. The ticks
   * that fall inside it are skipped rather than stacked on top of it, because
   * a second full sample is more load on the daemon a deploy is waiting for.
   */
  it('lets one sample finish before the next starts, however many ticks pass', async () => {
    const docker = new FakeDockerEngine(nine(), new Set(), new Map(), SLOW_STATS_MS);
    const collector = new MetricsCollector(docker, new FakeHost(), 5, DOCKER_TIMEOUT_MS);

    const unsubscribe = collector.subscribe(() => undefined);

    try {
      await waitFor(() => docker.lists >= 1, 2_000, 'the first sample');
      await new Promise((resolve) => setTimeout(resolve, DOCKER_TIMEOUT_MS + 15));
      assert.equal(docker.lists, 1, 'a tick inside a running sample is skipped, not stacked on top of it');
      await waitFor(() => docker.lists >= 2, 2_000, 'the sample after that one');
    } finally {
      unsubscribe();
    }
  });

  it('ends a sample whose host reading never answers, and samples again', async () => {
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
      assert.ok(host.calls >= 2, 'a reading that never answers must not end the sampling');
    } finally {
      unsubscribe();
    }
  });
});
