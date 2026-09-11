import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { DockerBeeAcquisitionError } from '../domain/errors/DockerBeeAcquisitionError.js';
import type { SshDockerForwardCommand } from '../domain/chequebook/sshDockerForwardCommand.js';
import type { ForwardSpawnOwnership } from './sshForwardResources.js';
import { validateForwardStart, type ForwardStart } from './sshForwardProtocol.js';
import { attachSupervisedForwardChild, type SupervisedForwardChild, type SupervisorProcess, type SupervisorProcessEvent } from './supervisedForwardChild.js';

export interface NativeSupervisorDependencies {
  readonly uid: number;
  nowMs(): number;
  nowNs(): bigint;
  leaseId(): string;
  createProcess(): SupervisorProcess;
}

function forkPackagedSupervisor(): ChildProcess {
  const source = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(new URL(source ? './sshForwardSupervisorProcess.ts' : './sshForwardSupervisorProcess.js', import.meta.url));
  return fork(entry, [], { execPath: process.execPath,
    execArgv: source ? ['--import', import.meta.resolve('tsx'), '--conditions=development'] : [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], detached: false, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
}

/** Fixed packaged entrypoint and isolated environment. The injected child factory is for owned Node test fixtures only. */
export function createNativeSupervisorProcess(createChild: () => ChildProcess = forkPackagedSupervisor): SupervisorProcess {
  const child = createChild();
  const listeners = new Set<(value: SupervisorProcessEvent) => void>();
  let terminal: SupervisorProcessEvent | undefined;
  const emit = (event: SupervisorProcessEvent) => {
    if (terminal?.type === 'closed') return;
    if (event.type === 'failed' || event.type === 'closed') terminal = event;
    for (const listener of [...listeners]) listener(event);
  };
  child.on('error', () => emit({ type: 'failed' }));
  child.on('close', () => emit({ type: 'closed' }));
  child.on('message', value => emit({ type: 'message', value }));
  const stderr = child.stderr ?? new PassThrough();
  stderr.on('error', () => emit({ type: 'failed' }));
  if (!child.stderr) emit({ type: 'failed' });
  return Object.freeze({ stderr,
    observe(listener: (event: SupervisorProcessEvent) => void) { listeners.add(listener); if (terminal) listener(terminal); return () => { listeners.delete(listener); }; },
    send(value: ForwardStart | Readonly<{ type: 'stop'; leaseId: string }>) {
      try {
        if (!child.connected) throw new DockerBeeAcquisitionError();
        child.send(value, error => { if (error) emit({ type: 'failed' }); });
      } catch { emit({ type: 'failed' }); throw new DockerBeeAcquisitionError(); }
    },
  });
}

const nativeDependencies: NativeSupervisorDependencies = Object.freeze({ uid: process.getuid?.() ?? -1,
  nowMs: () => performance.now(), nowNs: () => process.hrtime.bigint(), leaseId: randomUUID, createProcess: createNativeSupervisorProcess });

/** Convert deadlines conservatively before child creation. Neither fork nor IPC handoff starts another acquisition allowance. */
export function spawnSupervisedForward(command: SshDockerForwardCommand, ownership: ForwardSpawnOwnership | undefined,
  dependencies: NativeSupervisorDependencies = nativeDependencies): SupervisedForwardChild {
  let start: ForwardStart;
  const uid = dependencies.uid;
  try {
    if (!ownership) throw new DockerBeeAcquisitionError();
    const originNs = dependencies.nowNs(); const originMs = dependencies.nowMs();
    const captured = structuredClone({ locator: command.target, directory: ownership.directory, socketPath: ownership.socketPath,
      acquisition: ownership.acquisitionDeadlineMs, operational: ownership.operationalDeadlineMs, cleanup: ownership.cleanupDeadlineMs });
    const convert = (value: number) => String(originNs + BigInt(Math.floor((value - originMs) * 1e6)));
    start = validateForwardStart({ type: 'start', leaseId: dependencies.leaseId(), locator: captured.locator, directory: captured.directory,
      socketPath: captured.socketPath, acquisitionDeadlineNs: convert(captured.acquisition), operationalDeadlineNs: convert(captured.operational),
      cleanupDeadlineNs: convert(captured.cleanup) }, dependencies.nowNs(), uid).start;
  } catch { throw new DockerBeeAcquisitionError(); }
  const process = dependencies.createProcess();
  return attachSupervisedForwardChild(start, process, { uid, nowNs: () => dependencies.nowNs(), delegateCleanup: () => ownership!.delegateCleanup() });
}
