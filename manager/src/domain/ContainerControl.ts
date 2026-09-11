import {
  type EngineName,
  OME_SERVICE,
  RESTARTABLE_SERVICES,
  SRS_SERVICE,
} from '@streaming-infra-manager/common';
import Docker from 'dockerode';
import { connect } from 'node:net';
import { dirname } from 'node:path';

import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_SERVICE_LABEL,
  COMPOSE_WORKING_DIR_LABEL,
} from './composeLabels.js';
import { answeredInTime, DOCKER_TIMEOUT_MS } from './dockerTimeout.js';
import {
  ContainerNotRunningError,
  DockerUnavailableError,
  RestartInProgressError,
  UnknownServiceError,
} from './errors/index.js';
import {
  demultiplexDockerStream,
  readBounded,
  type StreamBounds,
} from './dockerStream.js';
import { EventBus } from './EventBus.js';
import { LOCAL_PUBLISHED_HOST } from './localHost.js';
import { Logger } from './Logger.js';
import { collectPublishedPorts } from './ports/publishedPorts.js';
import type { PublishedPortsSnapshot } from './ports/PublishedPortsProbe.js';

const logger = Logger.getInstance();

/** Seconds docker waits for the process to exit before it kills it. */
const RESTART_TIMEOUT_SECONDS = 10;

/** One attempt to open a TCP connection, and the pause before the next. */
const PORT_ATTEMPT_MS = 2_000;
const PORT_RETRY_MS = 500;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function connects(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (outcome: boolean) => {
      socket.destroy();
      resolve(outcome);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * How long after a restart the same container refuses another one.
 *
 * Long enough to cover the seconds a container spends looking down while it
 * comes back, which is when the button gets pressed a second time.
 */
const RESTART_COOLDOWN_MS = 10_000;

const MAX_LOG_LINES = 2000;
const DEFAULT_LOG_LINES = 200;

/**
 * A generated engine config runs to a few kilobytes. The cap is here because
 * `cat` reads whatever is at that path, and an answer the browser cannot render
 * is worse than a truncated one.
 */
export const MAX_CONFIG_BYTES = 256 * 1024;

/**
 * What a log read is allowed to cost.
 *
 * The line count alone is not a bound: a single line has no length limit, and a
 * container that logs a stack trace per frame writes megabytes of them. The
 * idle gap is what ends a normal read, because the followed stream stays open
 * after the tail has been delivered, and the total is the backstop for a
 * container writing continuously.
 */
export const DEFAULT_LOG_BOUNDS: StreamBounds = {
  maxBytes: 1024 * 1024,
  idleMs: 500,
  totalMs: 5_000,
};

/** Overridable so a test does not have to wait out the real ones. */
export interface ContainerControlLimits {
  log: StreamBounds;
  restartCooldownMs: number;
  dockerTimeoutMs: number;
}

const DEFAULT_LIMITS: ContainerControlLimits = {
  log: DEFAULT_LOG_BOUNDS,
  restartCooldownMs: RESTART_COOLDOWN_MS,
  dockerTimeoutMs: DOCKER_TIMEOUT_MS,
};

/** Where each entrypoint writes the config it generated from the template. */
const ENGINE_CONFIG_PATHS: Record<EngineName, string> = {
  [SRS_SERVICE]: '/usr/local/srs/conf/srs.conf',
  [OME_SERVICE]: '/opt/ovenmediaengine/bin/origin_conf/Server.xml',
};

/**
 * The slice of dockerode this uses.
 *
 * Named so a test can hand over a double without standing up a Docker daemon,
 * and narrow so what this class is allowed to do to a container is visible in
 * one place.
 */
export interface ContainerHandle {
  restart(options: { t: number }): Promise<unknown>;
  logs(
    options: Docker.ContainerLogsOptions & { follow: true },
  ): Promise<NodeJS.ReadableStream>;
  exec(options: Docker.ExecCreateOptions): Promise<ExecHandle>;
  inspect(): Promise<InspectedContainer>;
}

/**
 * The part of `docker inspect` the watch after a config change reads.
 *
 * Picked out of dockerode's own type so the shape stays Docker's: the restart
 * count sits beside `State`, not inside it, and a double that puts it under
 * `State` no longer compiles.
 */
export type InspectedContainer = Pick<Docker.ContainerInspectInfo, 'Id' | 'RestartCount'> & {
  Config?: { Labels?: Record<string, string> };
  NetworkSettings?: { Ports?: unknown };
  HostConfig?: { NetworkMode?: string };
  State: Pick<Docker.ContainerInspectInfo['State'], 'Status' | 'StartedAt'>;
};

/** One container's state, as `inspect` answers it. */
export interface ContainerState {
  id: string;
  /** `running`, `restarting`, `exited` and the rest of Docker's words. */
  status: string;
  /** How many times the restart policy brought it back. Zero for a fresh one. */
  restartCount: number;
  startedAt: string | null;
}

export interface ExecHandle {
  start(options: Docker.ExecStartOptions): Promise<NodeJS.ReadableStream>;
}

/** The two fields of a container listing this reads. */
export interface ListedContainer {
  Id: string;
  Labels?: Record<string, string>;
}

export interface DockerEngine {
  /** `docker info`, for the daemon's own id. */
  info(): Promise<unknown>;
  listContainers(
    options: Docker.ContainerListOptions,
  ): Promise<ListedContainer[]>;
  getContainer(id: string): ContainerHandle;
}

/**
 * Restarting one container, reading its logs, and reading the config the engine
 * actually generated at startup.
 *
 * All three go through the Docker socket the metrics collector already uses,
 * because none of them is expressible as a deploy: a restart must not move the
 * profile's status, and the generated config only exists inside the container.
 */
export class ContainerControl {
  private readonly limits: ContainerControlLimits;

  /** Restarts under way, and when the last one of each stops refusing another. */
  private readonly restarting = new Set<string>();
  private readonly restartableFrom = new Map<string, number>();

  constructor(
    private readonly events: EventBus,
    private readonly docker: DockerEngine = new Docker({
      timeout: DOCKER_TIMEOUT_MS,
    }),
    limits: Partial<ContainerControlLimits> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /**
   * The one running container for a deployment's service.
   *
   * Both labels are required. Matching on the project alone would return every
   * container of the deployment, and on the service alone every deployment's
   * copy of that service, which on a host with a dozen streams is eleven
   * chances to restart the wrong one.
   */
  async find(profile: string, service: string): Promise<ContainerHandle> {
    const containers = await this.withinLimit(
      this.docker.listContainers({
        all: false,
        filters: {
          label: [
            `${COMPOSE_PROJECT_LABEL}=${profile}`,
            `${COMPOSE_SERVICE_LABEL}=${service}`,
          ],
        },
      }),
    );

    // The daemon is asked to filter and the answer is checked anyway: an older
    // daemon that ignored one of the label filters would hand back a container
    // belonging to another deployment, and this is a restart.
    const match = containers.find(
      (info) =>
        info.Labels?.[COMPOSE_PROJECT_LABEL] === profile &&
        info.Labels?.[COMPOSE_SERVICE_LABEL] === service,
    );
    if (!match) throw new ContainerNotRunningError(profile, service);

    return this.docker.getContainer(match.Id);
  }

  /**
   * The root the service's container was started from, read off the compose
   * working directory label the container carries, or null when there is no
   * container. This is what a build reference is resolved by: what runs,
   * never what a deploy planned.
   */
  async mountedRootOf(profile: string, service: string): Promise<string | null> {
    const containers = await this.withinLimit(
      this.docker.listContainers({
        all: true,
        filters: {
          label: [
            `${COMPOSE_PROJECT_LABEL}=${profile}`,
            `${COMPOSE_SERVICE_LABEL}=${service}`,
          ],
        },
      }),
    );
    const match = containers.find(
      (info) =>
        info.Labels?.[COMPOSE_PROJECT_LABEL] === profile &&
        info.Labels?.[COMPOSE_SERVICE_LABEL] === service,
    );
    const workingDir = match?.Labels?.[COMPOSE_WORKING_DIR_LABEL];
    if (!workingDir) return null;
    return dirname(workingDir);
  }

  /** Whether a container of exactly this name exists, in any state. Throws when Docker cannot be asked. */
  async containerExists(name: string): Promise<boolean> {
    try {
      await this.withinLimit(this.docker.getContainer(name).inspect());
      return true;
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return false;
      throw err;
    }
  }

  /**
   * Whether a TCP connection to a port the deployment publishes opens within
   * the budget, trying again until it does or the budget is spent. Liveness
   * only: a port that answers says a process listens, nothing about what it
   * will serve.
   */
  async reachable(port: number, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      if (await connects(LOCAL_PUBLISHED_HOST, port, Math.min(PORT_ATTEMPT_MS, left))) {
        return true;
      }
      if (deadline - Date.now() <= PORT_RETRY_MS) return false;
      await sleep(PORT_RETRY_MS);
    }
  }

  /** A fresh identity for target verification and for judging recorded attempts. */
  async daemonId(): Promise<string> {
    const info = (await this.withinLimit(this.docker.info())) as { ID?: string };
    if (typeof info.ID !== 'string' || !info.ID.trim()) {
      logger.error('[ContainerControl] docker info answered no daemon id');
      throw new DockerUnavailableError();
    }
    return info.ID;
  }

  async publishedPorts(): Promise<Omit<PublishedPortsSnapshot, 'daemonId'>> {
    const listed = await this.withinLimit(this.docker.listContainers({ all: false }));
    const rows: unknown[] = [];
    for (const container of listed) {
      const info = await this.withinLimit(this.docker.getContainer(container.Id).inspect());
      if (!['running', 'restarting', 'paused'].includes(info.State.Status)) continue;
      if (!info.NetworkSettings || !('Ports' in info.NetworkSettings)) {
        throw new Error('Docker did not report published ports');
      }
      rows.push({
        id: info.Id,
        project: info.Config?.Labels?.[COMPOSE_PROJECT_LABEL] ?? null,
        service: info.Config?.Labels?.[COMPOSE_SERVICE_LABEL] ?? null,
        ports: info.NetworkSettings.Ports,
        networkMode: info.HostConfig?.NetworkMode,
      });
    }
    return collectPublishedPorts(rows);
  }

  /** Every container of the project, all states, by the service compose labels it. */
  async containerIdsOf(project: string): Promise<Map<string, string[]>> {
    const containers = await this.withinLimit(
      this.docker.listContainers({
        all: true,
        filters: { label: [`${COMPOSE_PROJECT_LABEL}=${project}`] },
      }),
    );
    const byService = new Map<string, string[]>();
    for (const info of containers) {
      if (info.Labels?.[COMPOSE_PROJECT_LABEL] !== project) continue;
      const service = info.Labels?.[COMPOSE_SERVICE_LABEL];
      if (!service) continue;
      byService.set(service, [...(byService.get(service) ?? []), info.Id]);
    }
    return byService;
  }

  /**
   * The state of a deployment's service container in any state, or null when
   * there is none at all.
   *
   * Every state rather than the running ones only, because the question this
   * answers is whether a container the deploy just created is still up, and
   * one that died is exactly the answer wanted.
   */
  async inspect(profile: string, service: string): Promise<ContainerState | null> {
    const containers = await this.withinLimit(
      this.docker.listContainers({
        all: true,
        filters: {
          label: [
            `${COMPOSE_PROJECT_LABEL}=${profile}`,
            `${COMPOSE_SERVICE_LABEL}=${service}`,
          ],
        },
      }),
    );
    const match = containers.find(
      (info) =>
        info.Labels?.[COMPOSE_PROJECT_LABEL] === profile &&
        info.Labels?.[COMPOSE_SERVICE_LABEL] === service,
    );
    if (!match) return null;

    const info = await this.withinLimit(this.docker.getContainer(match.Id).inspect());
    return {
      id: info.Id,
      status: info.State.Status,
      restartCount: info.RestartCount,
      startedAt: info.State.StartedAt,
    };
  }

  /**
   * Bounces one container, at most one bounce at a time and not twice in a row.
   *
   * The guard is per deployment and service rather than global: two operators
   * restarting two different streams are not in each other's way, and the
   * failure this prevents is one container being restarted on top of itself.
   * A restart that failed sets no cooldown, so a fixed problem can be retried
   * at once.
   */
  async restart(profile: string, service: string): Promise<void> {
    if (!RESTARTABLE_SERVICES.includes(service)) {
      throw new UnknownServiceError(service, RESTARTABLE_SERVICES);
    }

    const key = `${profile}/${service}`;
    const restartableFrom = this.restartableFrom.get(key) ?? 0;
    if (this.restarting.has(key) || Date.now() < restartableFrom) {
      throw new RestartInProgressError(profile, service);
    }

    this.restarting.add(key);
    try {
      const container = await this.find(profile, service);
      await this.withinLimit(container.restart({ t: RESTART_TIMEOUT_SECONDS }));
      this.restartableFrom.set(key, Date.now() + this.limits.restartCooldownMs);
    } finally {
      this.restarting.delete(key);
    }

    logger.info(`[ContainerControl] restarted ${service} for ${profile}`);
    this.events.publish({ type: 'engine.restarted', profile, service });
  }

  async logs(
    profile: string,
    service: string,
    tail: number = DEFAULT_LOG_LINES,
  ): Promise<string> {
    const container = await this.find(profile, service);
    // Followed rather than fetched whole: without `follow` the daemon assembles
    // the entire answer and hands it over as one buffer, so the line count is
    // applied to something already in memory. Followed, it arrives in pieces
    // that the bounds can stop.
    const stream = await this.withinLimit(
      container.logs({
        stdout: true,
        stderr: true,
        follow: true,
        timestamps: true,
        tail: Math.min(Math.max(tail, 1), MAX_LOG_LINES),
      }),
    );

    const raw = await readBounded(stream, this.limits.log);
    return lastLines(demultiplexDockerStream(raw), MAX_LOG_LINES);
  }

  /**
   * The config the engine is running, read out of the container.
   *
   * Both entrypoints fill a template from environment variables at startup, so
   * this file is the only place that says which values actually applied. It
   * carries the SRT passphrase in clear, which the profile JSON already does,
   * but the route still answers it `no-store`.
   */
  async effectiveConfig(profile: string, engine: EngineName): Promise<string> {
    const container = await this.find(profile, engine);
    const exec = await this.withinLimit(
      container.exec({
        Cmd: ['cat', ENGINE_CONFIG_PATHS[engine]],
        AttachStdout: true,
        AttachStderr: true,
      }),
    );
    const stream = await this.withinLimit(exec.start({ Detach: false }));

    const raw = await readBounded(stream, {
      maxBytes: MAX_CONFIG_BYTES,
      totalMs: this.limits.dockerTimeoutMs,
    });
    return demultiplexDockerStream(raw);
  }

  /**
   * The same call, with a bound on how long the daemon may take over it.
   *
   * A daemon that has stalled rather than refused holds the socket open and
   * says nothing, and every one of these calls is answering an HTTP request.
   */
  private withinLimit<T>(call: Promise<T>): Promise<T> {
    return answeredInTime(
      call,
      this.limits.dockerTimeoutMs,
      () => new DockerUnavailableError(),
    );
  }
}

/**
 * The last `limit` lines, without the empty one a trailing newline splits off.
 *
 * That empty string is not a line. Counted as one it pushed the oldest real
 * line out of a full answer and put a blank at the end of every answer.
 */
function lastLines(text: string, limit: number): string {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-limit).join('\n');
}
