/**
 * A stand-in for the slice of dockerode `ContainerControl` uses.
 *
 * It answers `listContainers` from a fixed list of label sets and records what
 * was asked of each container, so the tests can assert on the label match and
 * on the log options without a Docker daemon anywhere.
 */
import { Readable } from 'node:stream';

import type Docker from 'dockerode';

import type {
  ContainerHandle,
  DockerEngine,
  ExecHandle,
  InspectedContainer,
  ListedContainer,
} from '../../src/domain/ContainerControl.js';

export interface FakeContainer {
  id: string;
  labels: Record<string, string>;
  /** What `logs` streams back in one piece, framed the way Docker frames it. */
  logBytes?: Buffer;
  /**
   * A stream `logs` hands back instead, for the cases where when the read stops
   * is what is under test. Called once per `logs` call.
   */
  logStream?: () => NodeJS.ReadableStream;
  /** What an `exec` writes, already framed. */
  execBytes?: Buffer;
  /**
   * Accepts every call to this container and answers none, the way a daemon
   * that has stalled rather than refused behaves.
   */
  stalls?: boolean;
  /** What `inspect` answers. A running container that never restarted when absent. */
  state?: { status: string; restartCount: number };
}

/** A promise for a call the daemon accepted and will never answer. */
function neverAnswered<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

export interface OpenStream {
  stream: Readable;
  /** Ignored once the reader has destroyed the stream. */
  write: (text: string) => void;
  end: () => void;
}

/**
 * A stream that hands over what a test writes into it and does not end on its
 * own.
 *
 * This is what a followed log stream is: the tail arrives, and then the
 * connection stays open for lines that have not happened yet.
 */
export function openStream(): OpenStream {
  const stream = new Readable({ read() {} });
  return {
    stream,
    write: (text: string) => {
      if (!stream.destroyed) stream.push(Buffer.from(text, 'utf8'));
    },
    end: () => {
      if (!stream.destroyed) stream.push(null);
    },
  };
}

export interface FakeDocker extends DockerEngine {
  /** Every `listContainers` call, in order, as the daemon received it. */
  readonly listCalls: Docker.ContainerListOptions[];
  readonly restarted: { id: string; timeoutSeconds: number }[];
  readonly logOptions: Record<string, unknown>[];
  readonly execCommands: string[][];
}

/** One stdout frame: type 1, three zero bytes, big-endian length, payload. */
export function frame(text: string, streamType = 1): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

export function fakeDocker(
  containers: FakeContainer[],
  /** The listing itself never answers, whatever the containers say. */
  stalls = false,
): FakeDocker {
  const listCalls: Docker.ContainerListOptions[] = [];
  const restarted: { id: string; timeoutSeconds: number }[] = [];
  const logOptions: Record<string, unknown>[] = [];
  const execCommands: string[][] = [];

  const handleFor = (container: FakeContainer): ContainerHandle => ({
    async restart(options) {
      restarted.push({ id: container.id, timeoutSeconds: options.t });
      if (container.stalls) return neverAnswered<undefined>();
      return undefined;
    },
    async logs(options) {
      logOptions.push({ ...options });
      if (container.stalls) return neverAnswered<NodeJS.ReadableStream>();
      if (container.logStream) return container.logStream();
      return Readable.from([container.logBytes ?? Buffer.alloc(0)]);
    },
    async exec(options) {
      execCommands.push(options.Cmd ?? []);
      if (container.stalls) return neverAnswered<ExecHandle>();
      return {
        async start() {
          return Readable.from([container.execBytes ?? Buffer.alloc(0)]);
        },
      };
    },
    async inspect(): Promise<InspectedContainer> {
      if (container.stalls) return neverAnswered<InspectedContainer>();
      const state = container.state ?? { status: 'running', restartCount: 0 };
      return {
        Id: container.id,
        State: {
          Status: state.status,
          RestartCount: state.restartCount,
          StartedAt: '2026-09-07T10:00:00Z',
        },
      };
    },
  });

  return {
    listCalls,
    restarted,
    logOptions,
    execCommands,
    /** One daemon, one id: the guard keys its rows by it. */
    async info() {
      return { ID: 'fake-daemon' };
    },
    async listContainers(options) {
      listCalls.push(options);
      if (stalls) return neverAnswered<ListedContainer[]>();
      // Deliberately ignores the filters, the way an older daemon would when
      // handed a filter key it does not know. The label check in
      // ContainerControl.find is what has to catch that.
      return containers.map((container) => ({
        Id: container.id,
        Labels: container.labels,
      }));
    },
    getContainer(id) {
      const container = containers.find((entry) => entry.id === id);
      if (!container) throw new Error(`fakeDocker: no container ${id}`);
      return handleFor(container);
    },
  };
}
