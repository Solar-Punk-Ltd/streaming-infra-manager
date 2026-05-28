import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { getErrorMessage } from '@streaming-infra-manager/common';

import {
  KIND_DEFAULT_SERVICES,
  Profile,
  ProfileStatus,
} from '../types/index.js';
import {
  SCRIPT_CLEAN,
  SCRIPT_DEPLOY,
  SCRIPT_HEALTH,
  SCRIPT_STOP,
  SUBMODULE,
  deleteProfileEnv,
  parseBaseEnv,
} from '../utils/envUtils.js';

import { ContainerRepository } from './ContainerRepository.js';
import { buildContainerSnapshot } from './containerKeysSpec.js';
import { ProfileBusyError } from './errors/index.js';
import { EventBus } from './EventBus.js';
import { Logger } from './Logger.js';
import { ProfileRepository } from './ProfileRepository.js';
import { RunHandle, ScriptRunner } from './ScriptRunner.js';

const logger = Logger.getInstance();

const STDERR_TAIL_BYTES = 4096;
const STDOUT_TAIL_BYTES = 4096;

const BEE_DATA_ROOT =
  process.env.BEE_DATA_ROOT ?? '/home/solarpunk/streaming-infra-manager-data';

function beeDataDirsFor(profileName: string): Record<string, string> {
  return {
    BEE_UPLOADER_DATA_DIR: `${BEE_DATA_ROOT}/${profileName}/bee-uploader`,
    BEE_GATEWAY_DATA_DIR: `${BEE_DATA_ROOT}/${profileName}/bee-gateway`,
  };
}

function profileDataRoot(profileName: string): string {
  return join(BEE_DATA_ROOT, profileName);
}

// Mirrors PORT_VARS in deploy/scripts/_lib.sh — keep in sync.
const PORT_VAR_DEFAULTS: Record<string, number> = {
  API_PORT: 10000,
  SRS_SRT_PORT: 10001,
  SRS_RTMP_PORT: 10002,
  SRS_HTTP_PORT: 10003,
  CLIENT_PORT: 10004,
  BEE_UPLOADER_API_PORT: 10005,
  BEE_UPLOADER_P2P_PORT: 10006,
  BEE_GATEWAY_API_PORT: 10007,
  BEE_GATEWAY_P2P_PORT: 10008,
};

interface JobConfig {
  profileName: string;
  script: string;
  args: string[];

  transitionTo?: ProfileStatus;

  allowedFrom?: readonly ProfileStatus[];

  onSuccess: () => Promise<void>;
}

export class DeploymentOrchestrator {
  constructor(
    private readonly profiles: ProfileRepository,
    private readonly containers: ContainerRepository,
    private readonly runner: ScriptRunner,
    private readonly eventBus: EventBus,
  ) {}

  private async publishChanged(profile: Profile): Promise<void> {
    const withContainers = await this.containers.withContainers(profile);
    this.eventBus.publish({ type: 'profile.changed', profile: withContainers });
  }

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
        const updated = await this.profiles.markTerminal(
          profile.name,
          'RUNNING',
        );
        await this.snapshotContainers(profile, resolved);
        if (updated) {
          await this.publishChanged(updated);
        }
      },
    });
  }

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
        const updated = await this.profiles.markTerminal(
          profile.name,
          'RUNNING',
        );
        await this.snapshotContainers(profile, resolved);
        if (updated) {
          await this.publishChanged(updated);
        }
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
      onSuccess: async () => {
        const updated = await this.profiles.markTerminal(
          profile.name,
          'STOPPED',
        );
        if (updated) {
          await this.publishChanged(updated);
        }
      },
    });
  }

  async startRemove(
    profile: Profile,
    input: { all?: boolean } = {},
  ): Promise<RunHandle> {
    const args: string[] = [
      `--profile=${profile.name}`,
      `--portSlot=${profile.port_slot}`,
      '--yes',
      '--volumes',
    ];
    if (input.all) {
      args.push('--all');
    }

    return this.runJob({
      profileName: profile.name,
      script: SCRIPT_CLEAN,
      args,
      transitionTo: 'REMOVING',
      allowedFrom: ['RUNNING', 'STOPPED', 'ERROR'],
      onSuccess: async () => {
        await this.removeProfileDataDir(profile.name);
        await this.profiles.deleteByName(profile.name);
        deleteProfileEnv(profile.name);
        this.eventBus.publish({ type: 'profile.deleted', name: profile.name });
        logger.info(
          `[Orchestrator] Removed profile ${profile.name} (released slot ${profile.port_slot})`,
        );
      },
    });
  }

  startHealth(profile: Profile): RunHandle {
    return this.runner.run(SCRIPT_HEALTH, this.buildScriptArgs(profile, []), {
      cwd: SUBMODULE,
      env: beeDataDirsFor(profile.name),
    });
  }

  private async runJob(cfg: JobConfig): Promise<RunHandle> {
    if (cfg.transitionTo && cfg.allowedFrom) {
      const transitioned = await this.profiles.transitionStatus(
        cfg.profileName,
        cfg.transitionTo,
        cfg.allowedFrom,
      );
      if (!transitioned) {
        // Either already in a transitional state, or row vanished. Re-fetch
        // so the caller can produce a useful 409.
        const current = await this.profiles.findByName(cfg.profileName);
        throw new ProfileBusyError(
          cfg.profileName,
          current?.status ?? 'REMOVING',
        );
      }
      await this.publishChanged(transitioned);
    }

    logger.info(
      `[Orchestrator] ${cfg.profileName} running: bash ${cfg.script} ${cfg.args.join(' ')}`,
    );

    const handle = this.runner.run(cfg.script, cfg.args, {
      cwd: SUBMODULE,
      env: beeDataDirsFor(cfg.profileName),
    });

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
        return;
      }
      const message =
        stderrTail.trim() ||
        stdoutTail.trim() ||
        `${cfg.script} exited with code ${code}`;
      const errored = await this.profiles.markError(cfg.profileName, message);
      if (errored) {
        await this.publishChanged(errored);
      }
      logger.warn(
        `[Orchestrator] ${cfg.profileName} ← ERROR (code=${code})\n${message}`,
      );
    } catch (err) {
      const message = getErrorMessage(err);
      logger.error(
        `[Orchestrator] failed to finalize ${cfg.profileName}: ${message}`,
      );
      try {
        const errored = await this.profiles.markError(cfg.profileName, message);
        if (errored) {
          await this.publishChanged(errored);
        }
      } catch (markErr) {
        logger.error(
          `[Orchestrator] failed to mark ${cfg.profileName} ERROR: ${getErrorMessage(markErr)}`,
        );
      }
    }
  }

  private buildScriptArgs(
    profile: Profile,
    services: string[],
    hostOverride?: string,
  ): string[] {
    const args = [
      `--profile=${profile.name}`,
      `--portSlot=${profile.port_slot}`,
    ];
    const host = hostOverride ?? profile.host ?? 'localhost';
    if (host) args.push(`--host=${host}`);
    if (profile.feed_owner) args.push(`--feed-owner=${profile.feed_owner}`);
    if (profile.feed_topic) args.push(`--feed-topic=${profile.feed_topic}`);
    if (profile.private_key) args.push(`--private-key=${profile.private_key}`);
    if (profile.stamp_id) args.push(`--stamp-id=${profile.stamp_id}`);
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

  private async removeProfileDataDir(profileName: string): Promise<void> {
    if (
      !profileName ||
      /[/\\]/.test(profileName) ||
      profileName.includes('..')
    ) {
      throw new Error(
        `refusing to remove data dir for suspicious name "${profileName}"`,
      );
    }
    const dir = profileDataRoot(profileName);
    await rm(dir, { recursive: true, force: true });
    logger.info(`[Orchestrator] removed data dir ${dir}`);
  }

  private async snapshotContainers(
    profile: Profile,
    services: string[],
  ): Promise<void> {
    try {
      const env = this.buildEffectiveEnv(profile);
      for (const service of services) {
        const snapshot = buildContainerSnapshot(service, env);
        await this.containers.upsert(profile.name, snapshot);
      }
    } catch (err) {
      logger.warn(
        `[Orchestrator] failed to snapshot containers for ${profile.name}: ${getErrorMessage(err)}`,
      );
    }
  }

  private buildEffectiveEnv(profile: Profile): Record<string, string> {
    const env = parseBaseEnv();

    Object.assign(env, beeDataDirsFor(profile.name));

    for (const [name, def] of Object.entries(PORT_VAR_DEFAULTS)) {
      if (profile.port_slot === 0) {
        if (env[name] === undefined || env[name] === '') {
          env[name] = String(def);
        }
      } else {
        env[name] = String(def + profile.port_slot * 10);
      }
    }
    if (env.API_PORT) env.SRS_ADAPTER_PORT = env.API_PORT;

    // Parameter overrides — same mapping as deploy/scripts/_lib.sh::parameter_overrides_text.
    if (profile.feed_owner) {
      env.VITE_APP_OWNER = profile.feed_owner.replace(/^0x/, '');
    }
    if (profile.feed_topic) {
      env.STREAM_LIST_TOPIC = profile.feed_topic;
      env.VITE_APP_RAW_TOPIC = profile.feed_topic;
    }
    if (profile.private_key) {
      env.STREAM_KEY = profile.private_key;
    }
    if (profile.stamp_id) {
      env.STAMP = profile.stamp_id.replace(/^0x/, '');
    }

    return env;
  }
}
