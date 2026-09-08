import { execFile } from 'node:child_process';

import { TargetNotVerifiedError } from '../errors/index.js';
import type { DaemonObserver, DaemonSnapshot } from '../DeployAttemptRepository.js';
import { isLocalTarget, targetAlias } from './DeployTargets.js';
import type { TargetIdentityProbe } from './VerifiedDeployTargets.js';

/** Captures only the selected non-secret fields, with a bounded runtime and output. */
export type ReadOnlyCommand = (file: string, args: readonly string[]) => Promise<string>;

const readOnlyCommand: ReadOnlyCommand = (file, args) => new Promise((resolve, reject) => {
  execFile(file, [...args], { timeout: 15_000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout) => {
    if (error) reject(new Error('Docker target probe failed'));
    else resolve(stdout);
  });
});

export class TargetDocker implements TargetIdentityProbe, DaemonObserver {
  constructor(
    private readonly local: { daemonId(): Promise<string>; containerIdsOf?(project: string): Promise<Map<string, string[]>> },
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
    return (await this.snapshot(project, host)).containers;
  }

  async snapshot(project: string, host = 'localhost'): Promise<DaemonSnapshot> {
    const alias = targetAlias(host);
    if (isLocalTarget(alias)) {
      if (!this.local.containerIdsOf) throw new Error('Local container reader is not configured');
      const daemonId = await this.local.daemonId();
      const containers = await this.local.containerIdsOf(project);
      if (daemonId !== await this.local.daemonId()) throw new Error('Docker changed during observation');
      return { daemonId, containers };
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(project)) throw new Error('Invalid Compose project');
    const output = await this.run('ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes', alias,
      `docker info --format '{{json .ID}}' && docker ps -a --no-trunc --filter 'label=com.docker.compose.project=${project}' --format '{{.ID}} {{.Label "com.docker.compose.service"}}' && docker info --format '{{json .ID}}'`,
    ]);
    const lines = output.trim().split('\n');
    const first: unknown = JSON.parse(lines.shift() ?? '');
    const last: unknown = JSON.parse(lines.pop() ?? '');
    if (typeof first !== 'string' || !first.trim() || first !== last) {
      throw new Error('Docker identity changed or was unreadable during observation');
    }
    const byService = new Map<string, string[]>();
    for (const line of lines) {
      const match = /^([a-f0-9]{64}) ([a-zA-Z0-9_-]+)$/.exec(line.trim());
      if (!match) throw new Error('Unreadable container identity');
      const id = match[1]!;
      const service = match[2]!;
      byService.set(service, [...(byService.get(service) ?? []), id]);
    }
    return { daemonId: first, containers: byService };
  }
}
