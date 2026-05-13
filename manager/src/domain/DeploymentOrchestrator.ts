import { KIND_DEFAULT_SERVICES, Profile, ProfileStatus } from '../types.js';
import {
  SCRIPT_CLEAN,
  SCRIPT_DEPLOY,
  SCRIPT_HEALTH,
  SCRIPT_STOP,
  SUBMODULE,
  deleteProfileEnv,
  parseProfileEnv,
} from '../utils/repo.js';

import { ContainerRepository } from './ContainerRepository.js';
import { buildContainerSnapshot } from './containerKeysSpec.js';
import { Logger } from './Logger.js';
import { ProfileRepository } from './ProfileRepository.js';
import { RunHandle, ScriptRunner } from './ScriptRunner.js';

const logger = Logger.getInstance();

/** Thrown when a trigger collides with an in-flight transition. */
export class ProfileBusyError extends Error {
  constructor(
    public readonly name: string,
    public readonly currentStatus: ProfileStatus,
  ) {
    super(`Profile ${name} is busy (status=${currentStatus})`);
    this.name = 'ProfileBusyError';
  }
}

const STDERR_TAIL_BYTES = 4096;
const STDOUT_TAIL_BYTES = 4096;

interface JobConfig {
  profileName: string;
  script: string;
  args: string[];
  /**
   * Status to compare-and-swap into. When omitted (initial deploy from a
   * just-inserted row) the row is assumed to already hold the right status
   * and no CAS is performed.
   */
  transitionTo?: ProfileStatus;
  /** Statuses we accept as "ok to start from". Required when transitioning. */
  allowedFrom?: readonly ProfileStatus[];
  /** What happens on success. */
  onSuccess: () => Promise<void>;
}

/**
 * Owns the (status transition → spawn script → status update) lifecycle.
 *
 * `start*` returns a RunHandle for callers (SSE) that want to stream the
 * output, but the DB updates happen regardless of whether anyone subscribes.
 * The HTTP layer above should not await the run — it has already returned
 * 202 to the client.
 */
export class DeploymentOrchestrator {
  constructor(
    private readonly repo: ProfileRepository,
    private readonly containers: ContainerRepository,
    private readonly runner: ScriptRunner,
  ) {}

  async startDeploy(
    profile: Profile,
    services: string[] | undefined,
  ): Promise<RunHandle> {
    const resolved = this.resolveServices(profile, services);
    return this.runJob({
      profileName: profile.name,
      script: SCRIPT_DEPLOY,
      args: this.buildScriptArgs(profile, resolved),
      transitionTo: 'DEPLOYING',
      allowedFrom: ['RUNNING', 'STOPPED', 'ERROR'],
      onSuccess: async () => {
        await this.repo.markTerminal(profile.name, 'RUNNING');
        await this.snapshotContainers(profile.name, resolved);
      },
    });
  }

  /**
   * Variant of startDeploy used by ProfileService.create — the row was just
   * inserted in DEPLOYING, so we skip the CAS (it would fail since DEPLOYING
   * is not in the normal allowedFrom set). The caller is responsible for the
   * "just inserted, no concurrent trigger possible" guarantee.
   */
  async startInitialDeploy(
    profile: Profile,
    services: string[] | undefined,
    opts: { host?: string } = {},
  ): Promise<RunHandle> {
    const resolved = this.resolveServices(profile, services);
    return this.runJob({
      profileName: profile.name,
      script: SCRIPT_DEPLOY,
      args: this.buildScriptArgs(profile, resolved, opts.host),
      onSuccess: async () => {
        await this.repo.markTerminal(profile.name, 'RUNNING');
        await this.snapshotContainers(profile.name, resolved);
      },
    });
  }

  async startStop(
    profile: Profile,
    services: string[] | undefined,
  ): Promise<RunHandle> {
    return this.runJob({
      profileName: profile.name,
      script: SCRIPT_STOP,
      args: this.buildScriptArgs(profile, services ?? []),
      transitionTo: 'STOPPING',
      allowedFrom: ['RUNNING', 'ERROR'],
      onSuccess: () => this.repo.markTerminal(profile.name, 'STOPPED'),
    });
  }

  /**
   * Triggers clean.sh and, on success, deletes the DB row and the per-profile
   * env file. On failure the row stays in ERROR so the user can retry.
   */
  async startRemove(
    profile: Profile,
    input: { volumes?: boolean; all?: boolean } = {},
  ): Promise<RunHandle> {
    const args: string[] = [
      `--profile=${profile.name}`,
      `--portSlot=${profile.port_slot}`,
      '--yes',
    ];
    if (input.volumes) args.push('--volumes');
    if (input.all) args.push('--all');

    return this.runJob({
      profileName: profile.name,
      script: SCRIPT_CLEAN,
      args,
      transitionTo: 'REMOVING',
      allowedFrom: ['RUNNING', 'STOPPED', 'ERROR'],
      onSuccess: async () => {
        await this.repo.deleteByName(profile.name);
        deleteProfileEnv(profile.name);
        logger.info(
          `[Orchestrator] Removed profile ${profile.name} (released slot ${profile.port_slot})`,
        );
      },
    });
  }

  /**
   * health.sh is read-only — no status transition, no DB write. Kept here so
   * the route layer has a single dependency.
   */
  startHealth(profile: Profile): RunHandle {
    return this.runner.run(SCRIPT_HEALTH, this.buildScriptArgs(profile, []), {
      cwd: SUBMODULE,
    });
  }

  // --- internals ---

  private async runJob(cfg: JobConfig): Promise<RunHandle> {
    if (cfg.transitionTo && cfg.allowedFrom) {
      const transitioned = await this.repo.transitionStatus(
        cfg.profileName,
        cfg.transitionTo,
        cfg.allowedFrom,
      );
      if (!transitioned) {
        // Either already in a transitional state, or row vanished. Re-fetch
        // so the caller can produce a useful 409.
        const current = await this.repo.findByName(cfg.profileName);
        throw new ProfileBusyError(
          cfg.profileName,
          current?.status ?? 'REMOVING',
        );
      }
    }

    logger.info(
      `[Orchestrator] ${cfg.profileName} running: bash ${cfg.script} ${cfg.args.join(' ')}`,
    );

    const handle = this.runner.run(cfg.script, cfg.args, { cwd: SUBMODULE });

    // Buffer both streams — deploy.sh writes most errors to stdout, docker
    // build writes them to stderr; we want whatever's useful in the failure msg.
    let stderrTail = '';
    let stdoutTail = '';
    handle.emitter.on('stderr', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    handle.emitter.on('stdout', (chunk: string) => {
      stdoutTail = (stdoutTail + chunk).slice(-STDOUT_TAIL_BYTES);
    });

    handle.emitter.on('done', ({ code }: { code: number }) => {
      void this.finalizeJob(cfg, code, stderrTail, stdoutTail);
    });
    handle.emitter.on('error', (err: Error) => {
      void this.finalizeJob(cfg, -1, err.message, stdoutTail);
    });

    return handle;
  }

  private async finalizeJob(
    cfg: JobConfig,
    code: number,
    stderrTail: string,
    stdoutTail: string,
  ): Promise<void> {
    try {
      if (code === 0) {
        await cfg.onSuccess();
        logger.info(`[Orchestrator] ${cfg.profileName} ← success`);
      } else {
        const message =
          stderrTail.trim() ||
          stdoutTail.trim() ||
          `${cfg.script} exited with code ${code}`;
        await this.repo.markError(cfg.profileName, message);
        logger.warn(
          `[Orchestrator] ${cfg.profileName} ← ERROR (code=${code})\n${message}`,
        );
      }
    } catch (err) {
      // The terminal-state update itself failed. Log; nothing else we can do.
      logger.error(
        `[Orchestrator] failed to finalize ${cfg.profileName}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private buildScriptArgs(
    profile: Profile,
    services: string[],
    host?: string,
  ): string[] {
    const args = [
      `--profile=${profile.name}`,
      `--portSlot=${profile.port_slot}`,
    ];
    if (host) args.push(`--host=${host}`);
    args.push(...services);
    return args;
  }

  private resolveServices(
    profile: Profile,
    requested: string[] | undefined,
  ): string[] {
    if (requested && requested.length > 0) return requested;
    if (profile.components && profile.components.length > 0) {
      return [...profile.components];
    }
    return [...(KIND_DEFAULT_SERVICES[profile.kind] ?? [])];
  }

  /**
   * Snapshot the per-service slice of `.env.<profile>` into the containers
   * table on successful deploy. Best-effort: a failure here only logs and
   * does not flip the deploy to ERROR.
   */
  private async snapshotContainers(
    profileName: string,
    services: string[],
  ): Promise<void> {
    try {
      const env = parseProfileEnv(profileName);
      for (const service of services) {
        const snapshot = buildContainerSnapshot(service, env);
        await this.containers.upsert(profileName, snapshot);
      }
    } catch (err) {
      logger.warn(
        `[Orchestrator] failed to snapshot containers for ${profileName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
