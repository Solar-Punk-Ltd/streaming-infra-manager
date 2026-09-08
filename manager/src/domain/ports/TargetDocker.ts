import { execFile } from 'node:child_process';

import { TargetNotVerifiedError } from '../errors/index.js';
import type { DaemonObserver } from '../DeployAttemptRepository.js';
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
    const alias = targetAlias(host);
    if (isLocalTarget(alias)) {
      if (!this.local.containerIdsOf) throw new Error('Local container reader is not configured');
      return this.local.containerIdsOf(project);
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(project)) throw new Error('Invalid Compose project');
    const output = await this.run('ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes', alias,
      `docker ps -a --no-trunc --filter 'label=com.docker.compose.project=${project}' --format '{{.ID}} {{.Label "com.docker.compose.service"}}'`,
    ]);
    const byService = new Map<string, string[]>();
    for (const line of output.split('\n').filter((entry) => entry.trim())) {
      const match = /^([a-f0-9]{64}) ([a-zA-Z0-9_-]+)$/.exec(line.trim());
      if (!match) throw new Error('Unreadable container identity');
      const id = match[1]!;
      const service = match[2]!;
      byService.set(service, [...(byService.get(service) ?? []), id]);
    }
    return byService;
  }
}
