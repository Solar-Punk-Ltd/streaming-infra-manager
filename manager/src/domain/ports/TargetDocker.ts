import { execFile } from 'node:child_process';

import { TargetNotVerifiedError } from '../errors/index.js';
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

export class TargetDocker implements TargetIdentityProbe {
  constructor(
    private readonly local: { daemonId(): Promise<string> },
    private readonly run: ReadOnlyCommand = readOnlyCommand,
  ) {}

  async daemonId(host: string): Promise<string> {
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
}
