import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import type { ManagedSrsLifecycleConfig } from '../utils/config.js';
import { ReleaseGuardStore } from '../releaseGuard/ReleaseGuardStore.js';
import type { StackReleaseTarget } from '../releaseGuard/ReleaseGuardTypes.js';

import type {
  RunHandle,
  RunOptions,
  ScriptSpawner,
} from './ScriptRunner.js';

const INSTALLED_GUARD = '/opt/streaming-release-guard/streaming-release-guard';

export interface InstalledReleaseRouteInput {
  profile: string;
  portSlot: number;
  uploaderId: string;
  services: readonly string[];
  candidateRoot: string;
  lifecycle: ManagedSrsLifecycleConfig | null;
}

interface GuardInvocation {
  role: 'uploader' | 'viewer';
  args: string[];
}

export type InstalledReleaseRoute =
  | { kind: 'stack-script'; protectedProfile: false }
  | {
    kind: 'protected-subset';
    role: 'uploader' | 'viewer';
    operation: 'prepare' | 'update';
  }
  | {
    kind: 'guard';
    includesUploader: boolean;
    roles: readonly ('viewer' | 'uploader')[];
    invocations: readonly GuardInvocation[];
    environment: Record<string, string>;
  };

function sameServices(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length &&
    sortedLeft.every((service, index) => service === sortedRight[index]);
}

function includesEvery(outer: readonly string[], inner: readonly string[]): boolean {
  const available = new Set(outer);
  return inner.every((service) => available.has(service));
}

/**
 * Plans and runs a local deployment through the immutable guard installation
 * mounted into the manager API container.
 */
export class InstalledReleaseGuardRunner {
  private readonly store: ReleaseGuardStore;

  constructor(
    private readonly child: ScriptSpawner,
    private readonly stateRoot: string,
    private readonly command = INSTALLED_GUARD,
  ) {
    this.store = new ReleaseGuardStore(stateRoot);
  }

  async route(input: InstalledReleaseRouteInput): Promise<InstalledReleaseRoute> {
    const targets = await this.store.deploymentTargets();
    const matches = (['viewer', 'uploader'] as const)
      .map((role) => ({ role, target: targets[role] }))
      .filter((entry): entry is { role: 'viewer' | 'uploader'; target: StackReleaseTarget } =>
        entry.target?.profile === input.profile,
      );
    if (matches.length === 0) {
      if (input.lifecycle?.profile === input.profile) {
        throw new Error('configured managed uploader target is not installed');
      }
      return { kind: 'stack-script', protectedProfile: false };
    }

    for (const { target } of matches) {
      if (target.portSlot !== input.portSlot) {
        throw new Error('installed release guard target does not match the deployment port slot');
      }
    }

    const exact = matches.filter(({ target }) => includesEvery(input.services, target.services));
    const covered = [...new Set(exact.flatMap(({ target }) => target.services))];
    if (exact.length === 0 || !sameServices(covered, input.services)) {
      const update = input.services.includes('stream-uploader');
      return {
        kind: 'protected-subset',
        role: matches.some(({ role }) => role === 'uploader') ? 'uploader' : 'viewer',
        operation: update ? 'update' : 'prepare',
      };
    }

    const lifecycle = input.lifecycle;
    if (!lifecycle) {
      throw new Error('installed release guard requires managed lifecycle credentials');
    }
    const includesUploader = exact.some(({ role }) => role === 'uploader');
    if (includesUploader && lifecycle.profile !== input.profile) {
      throw new Error('installed uploader target does not match the configured managed profile');
    }
    const invocations = exact.map(({ role }) => ({
      role,
      args: [
        role,
        '--state-root', this.stateRoot,
        '--candidate-root', input.candidateRoot,
        '--work-root', join(this.stateRoot, 'manager-work', input.profile, role),
        '--admin-url', lifecycle.adminApiUrl,
        ...(role === 'uploader' ? ['--slot-id', input.uploaderId] : []),
      ],
    }));
    return {
      kind: 'guard',
      includesUploader,
      roles: invocations.map(({ role }) => role),
      invocations,
      environment: {
        ADMIN_API_TOKEN: lifecycle.adminApiToken,
        ADMIN_API_URL: lifecycle.adminApiUrl,
        RELEASE_GUARD_ADMIN_TOKEN: lifecycle.adminApiToken,
        RELEASE_GUARD_ADMIN_URL: lifecycle.adminApiUrl,
      },
    };
  }

  run(route: Extract<InstalledReleaseRoute, { kind: 'guard' }>, options: RunOptions): RunHandle {
    const emitter = new EventEmitter();
    let current: RunHandle | null = null;
    let ended = false;
    let cancelled = false;
    let nextIndex = 0;

    const finish = (event: 'done' | 'error', value: unknown) => {
      if (ended) return;
      ended = true;
      emitter.emit(event, value);
    };
    const startNext = () => {
      if (ended || cancelled) return;
      const invocation = route.invocations[nextIndex++];
      if (!invocation) {
        finish('done', { code: 0, signal: null });
        return;
      }
      current = this.child.run(this.command, invocation.args, {
        ...options,
        env: { ...options.env, ...route.environment },
        withholdOutput: true,
      });
      current.emitter.on('stdout', (chunk: string) => emitter.emit('stdout', chunk));
      current.emitter.on('stderr', (chunk: string) => emitter.emit('stderr', chunk));
      current.emitter.once('error', (error: Error) => {
        if (!cancelled) finish('error', error);
      });
      current.emitter.once('done', (outcome: { code: number; signal: NodeJS.Signals | null }) => {
        if (ended || cancelled) return;
        if (outcome.code !== 0 || outcome.signal) finish('done', outcome);
        else startNext();
      });
    };
    startNext();
    return {
      emitter,
      kill: () => {
        if (ended || cancelled) return;
        cancelled = true;
        current?.kill();
        finish('done', { code: -1, signal: 'SIGTERM' });
      },
    };
  }
}
