import { execFile } from 'node:child_process';

import { ContainerNotRunningError, TargetNotVerifiedError } from '../errors/index.js';
import {
  containerIdsByService,
  type DaemonObserver,
  type DaemonSnapshot,
  type ObservedContainer,
} from '../DeployAttemptRepository.js';
import type { LogWindow } from '../logWindow.js';
import { isLocalTarget, targetAlias } from './DeployTargets.js';
import type { TargetIdentityProbe } from './VerifiedDeployTargets.js';
import type { PublishedPortsProbe, PublishedPortsSnapshot } from './PublishedPortsProbe.js';
import { collectPublishedPorts } from './publishedPorts.js';
import { type MarkedLines, remoteLogLinesCommand, remoteLogLinesFrom } from './remoteLogLines.js';

/** Captures only the selected non-secret fields, with a bounded runtime and output. */
export type ReadOnlyCommand = (file: string, args: readonly string[]) => Promise<string>;

const readOnlyCommand: ReadOnlyCommand = (file, args) => new Promise((resolve, reject) => {
  execFile(file, [...args], { timeout: 15_000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout) => {
    if (error) reject(new Error('Docker target probe failed'));
    else resolve(stdout);
  });
});

export class TargetDocker implements TargetIdentityProbe, DaemonObserver, PublishedPortsProbe {
  constructor(
    private readonly local: {
      daemonId(): Promise<string>;
      observeContainers?(project: string): Promise<Map<string, ObservedContainer[]>>;
      publishedPorts?(): Promise<Omit<PublishedPortsSnapshot, 'daemonId'>>;
      logLinesContaining?(
        project: string,
        service: string,
        marker: string,
        window: LogWindow,
      ): Promise<string[]>;
    },
    private readonly run: ReadOnlyCommand = readOnlyCommand,
  ) {}

  async daemonId(host = 'localhost'): Promise<string> {
    const alias = targetAlias(host);
    if (isLocalTarget(alias)) return this.local.daemonId();
    const output = await this.run('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=yes',
      alias,
      "docker info --format '{{json .ID}}'",
    ]);
    const id: unknown = JSON.parse(output);
    if (typeof id !== 'string' || !id.trim()) throw new TargetNotVerifiedError(alias);
    return id;
  }

  async containerIdsOf(project: string, host = 'localhost'): Promise<Map<string, string[]>> {
    return containerIdsByService((await this.snapshot(project, host)).containers);
  }

  async publishedPorts(host: string): Promise<PublishedPortsSnapshot> {
    const alias = targetAlias(host);
    if (isLocalTarget(alias)) {
      if (!this.local.publishedPorts) throw new Error('Local published-port reader is not configured');
      const daemonId = await this.local.daemonId();
      const ports = await this.local.publishedPorts();
      if (daemonId !== await this.local.daemonId()) throw new Error('Docker changed during port observation');
      return { daemonId, ...ports };
    }
    const format = '{"id":{{json .Id}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"ports":{{json .NetworkSettings.Ports}},"networkMode":{{json .HostConfig.NetworkMode}}}';
    const command = `docker info --format '{{json .ID}}' && ids=$(docker ps -q --no-trunc) && { for id in $ids; do docker inspect --format '${format}' "$id" || exit 1; done; } && docker info --format '{{json .ID}}'`;
    const output = await this.run('ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes', alias, command,
    ]);
    const lines = output.trim().split('\n');
    const first: unknown = JSON.parse(lines.shift() ?? '');
    const last: unknown = JSON.parse(lines.pop() ?? '');
    if (typeof first !== 'string' || !first.trim() || first !== last) {
      throw new Error('Docker changed during port observation');
    }
    return { daemonId: first, ...collectPublishedPorts(lines.map((line) => JSON.parse(line))) };
  }

  async snapshot(project: string, host = 'localhost'): Promise<DaemonSnapshot> {
    const alias = targetAlias(host);
    if (isLocalTarget(alias)) {
      if (!this.local.observeContainers) throw new Error('Local container reader is not configured');
      const daemonId = await this.local.daemonId();
      const containers = await this.local.observeContainers(project);
      if (daemonId !== await this.local.daemonId()) throw new Error('Docker changed during observation');
      return { daemonId, containers };
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(project)) throw new Error('Invalid Compose project');
    const output = await this.run('ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes', alias,
      `docker info --format '{{json .ID}}' && docker ps -a --no-trunc --filter 'label=com.docker.compose.project=${project}' --format '{{.ID}} {{.Label "com.docker.compose.service"}} {{.State}}' && docker info --format '{{json .ID}}'`,
    ]);
    const lines = output.trim().split('\n');
    const first: unknown = JSON.parse(lines.shift() ?? '');
    const last: unknown = JSON.parse(lines.pop() ?? '');
    if (typeof first !== 'string' || !first.trim() || first !== last) {
      throw new Error('Docker identity changed or was unreadable during observation');
    }
    const byService = new Map<string, ObservedContainer[]>();
    for (const line of lines) {
      const match = /^([a-f0-9]{64}) ([a-zA-Z0-9_-]+) ([a-z]+)$/.exec(line.trim());
      if (!match) throw new Error('Unreadable container identity');
      const service = match[2]!;
      const observed: ObservedContainer = { id: match[1]!, state: match[3]! };
      byService.set(service, [...(byService.get(service) ?? []), observed]);
    }
    return { daemonId: first, containers: byService };
  }

  /**
   * The lines of a deployment's service log that carry `marker`, from the
   * daemon the deployment runs on.
   *
   * The local daemon is read through its socket and a remote one over ssh,
   * where the filter runs on the remote host, so no other line of the log
   * crosses the connection. Both answer a missing container with
   * `ContainerNotRunningError`.
   */
  async logLinesContaining(
    project: string,
    service: string,
    lines: MarkedLines,
    window: LogWindow,
    host: string | null = 'localhost',
  ): Promise<string[]> {
    const alias = targetAlias(host);
    if (isLocalTarget(alias)) {
      if (!this.local.logLinesContaining) throw new Error('Local log reader is not configured');
      return this.local.logLinesContaining(project, service, lines.marker, window);
    }
    const output = await this.run('ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes', alias,
      remoteLogLinesCommand(project, service, lines, window),
    ]);
    const answer = remoteLogLinesFrom(output, lines.marker);
    if (answer.container === 'none') throw new ContainerNotRunningError(project, service);
    return answer.lines;
  }
}
