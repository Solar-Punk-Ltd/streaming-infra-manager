import { EventEmitter } from 'node:events';
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
  bootstrapSubmoduleDefaults,
  deleteProfileEnv,
  parseBaseEnv,
  writeProfileStampEnv,
} from '../utils/envUtils.js';

import { ContainerRepository } from './ContainerRepository.js';
import { buildContainerSnapshot } from './containerKeysSpec.js';
import { ProfileBusyError, StampRequiredError } from './errors/index.js';
import { EventBus } from './EventBus.js';
import { Logger } from './Logger.js';
import { ProfileRepository } from './ProfileRepository.js';
import { RunHandle, ScriptRunner } from './ScriptRunner.js';
import {
  hasUsableStamp,
  splitDeployableServices,
  STREAM_UPLOADER_SERVICE,
} from './stampLogic.js';

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
    return this.deployResolved(profile, resolved, {
      transitionTo: 'DEPLOYING',
      allowedFrom: ['RUNNING', 'STOPPED', 'ERROR'],
    });
  }

  async startInitialDeploy(
    profile: Profile,
    services: string[] | undefined,
    opts: { host?: string } = {},
  ): Promise<RunHandle> {
    const resolved = this.resolveServices(profile, services);
    return this.deployResolved(profile, resolved, { host: opts.host });
  }

  /**
   * Incremental "deploy the held-back uploader" once a usable stamp exists.
   * Requires a stamp — otherwise the uploader would just be held back again.
   */
  async startDeployUploader(profile: Profile): Promise<RunHandle> {
    if (!hasUsableStamp(profile)) {
      throw new StampRequiredError(profile.name);
    }
    return this.deployResolved(profile, [STREAM_UPLOADER_SERVICE], {
      transitionTo: 'DEPLOYING',
      allowedFrom: ['RUNNING', 'STOPPED', 'ERROR'],
    });
  }

  /**
   * Shared deploy path: hold back the stream-uploader when there is no usable
   * stamp, write the per-profile STAMP env when the uploader IS deployed, then
   * run deploy.sh with the deployable set (or short-circuit if empty).
   */
  private async deployResolved(
    profile: Profile,
    resolved: string[],
    opts: {
      transitionTo?: ProfileStatus;
      allowedFrom?: readonly ProfileStatus[];
      host?: string;
    },
  ): Promise<RunHandle> {
    const { deploy, heldBack } = splitDeployableServices(profile, resolved);

    if (heldBack.length > 0) {
      logger.info(
        `[Orchestrator] ${profile.name}: holding back ${heldBack.join(', ')} — no usable stamp yet`,
      );
    }

    // When the uploader IS being deployed a usable stamp is present; make the
    // submodule's STAMP guard read a non-empty value from .env.<profile> so it
    // never hits its interactive prompt (which would EOF-abort under our runner).
    if (profile.stamp_id && deploy.includes(STREAM_UPLOADER_SERVICE)) {
      const written = writeProfileStampEnv(profile.name, profile.stamp_id);
      if (written) {
        logger.info(`[Orchestrator] ${profile.name}: wrote stamp env ${written}`);
      }
    }

    // Nothing deployable yet (e.g. an uploader-only custom profile without a
    // stamp): never call deploy.sh with an empty filter — that deploys ALL
    // config services. Mark RUNNING; pendingStamp surfaces the held-back state.
    if (deploy.length === 0) {
      return this.completeWithoutScript(profile, opts);
    }

    return this.runJob({
      profileName: profile.name,
      script: SCRIPT_DEPLOY,
      args: this.buildScriptArgs(profile, deploy, opts.host),
      transitionTo: opts.transitionTo,
      allowedFrom: opts.allowedFrom,
      onSuccess: async () => {
        const updated = await this.profiles.markTerminal(
          profile.name,
          'RUNNING',
        );
        await this.snapshotContainers(profile, deploy);
        if (updated) {
          await this.publishChanged(updated);
        }
      },
    });
  }

  /**
   * Finish a deploy that has no services to run (everything held back). Marks
   * the profile RUNNING and returns a no-op handle so callers can await/pipe it
   * exactly like a real script run.
   */
  private async completeWithoutScript(
    profile: Profile,
    opts: {
      transitionTo?: ProfileStatus;
      allowedFrom?: readonly ProfileStatus[];
    },
  ): Promise<RunHandle> {
    await this.ensureSubmoduleDefaults();

    // Same status gating as runJob — without it a held-back deploy could
    // overwrite a transitional status or report success while another job runs.
    if (opts.transitionTo && opts.allowedFrom) {
      const transitioned = await this.profiles.transitionStatus(
        profile.name,
        opts.transitionTo,
        opts.allowedFrom,
      );
      if (!transitioned) {
        const current = await this.profiles.findByName(profile.name);
        throw new ProfileBusyError(
          profile.name,
          current?.status ?? 'REMOVING',
        );
      }
    }

    const updated = await this.profiles.markTerminal(profile.name, 'RUNNING');
    if (updated) {
      await this.publishChanged(updated);
    }
    const emitter = new EventEmitter();
    setImmediate(() => emitter.emit('done', { code: 0 }));
    return { emitter, kill: () => undefined };
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

  async startHealth(profile: Profile): Promise<RunHandle> {
    await this.ensureSubmoduleDefaults();
    return this.runner.run(SCRIPT_HEALTH, this.buildScriptArgs(profile, []), {
      cwd: SUBMODULE,
      env: beeDataDirsFor(profile.name),
    });
  }

  /**
   * Guarantee the submodule's runtime config (.env, deploy/config.json) exists
   * before any script runs. The files are created once from their *.sample and
   * are gitignored, so a `deploy.sh` rsync --delete can wipe them between runs;
   * recreating here keeps profile actions working without a manager restart.
   */
  private async ensureSubmoduleDefaults(): Promise<void> {
    const created = await bootstrapSubmoduleDefaults();
    for (const file of created) {
      logger.info(`[Orchestrator] created missing default: ${file}`);
    }
  }

  private async runJob(cfg: JobConfig): Promise<RunHandle> {
    await this.ensureSubmoduleDefaults();

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
