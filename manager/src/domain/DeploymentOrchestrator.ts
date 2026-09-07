import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  abrLadderEnvValue,
  engineForComponents,
  type EngineName,
  engineSettingsEnv,
  getErrorMessage,
  ownsBeeNode,
} from '@streaming-infra-manager/common';

import { Profile, ProfileStatus } from '../types/index.js';
import {
  bootstrapStackDefaults,
  deleteProfileEnv,
  ENGINE_CONFIG_ENV_KEYS,
  parseBaseEnv,
  writeProfileEnv,
} from '../utils/envUtils.js';

import { ContainerRepository } from './ContainerRepository.js';
import { buildContainerSnapshot } from './containerKeysSpec.js';
import {
  beeDataDirsFor,
  engineConfigDirFor,
  engineConfigFileName,
  isEngineConfigFile,
  profileDataRoot,
} from './dataDirs.js';
import { DeploymentGroupRepository } from './DeploymentGroupRepository.js';
import { DeployAttemptRefusedError, ProfileBusyError, StampRequiredError } from './errors/index.js';
import {
  type AttemptOutcome,
  type DeployAttempt,
  type DeployAttemptKind,
  attemptOutcome,
  whyAdmissionIsRefused,
} from './deployAttempts.js';
import type { DaemonObserver, DeployAttemptRepository } from './DeployAttemptRepository.js';
import { EventBus } from './EventBus.js';
import { Logger } from './Logger.js';
import { ProfileRepository } from './ProfileRepository.js';
import { describeArgsForLog, RunHandle, ScriptRunner } from './ScriptRunner.js';
import {
  defaultServicesFor,
  hasBeePublishers,
  hasStampId,
  splitDeployableServices,
  STREAM_UPLOADER_SERVICE,
} from './stampLogic.js';
import { omePortsFor, portFor, portTableOf } from './versions/portTable.js';
import { stackPaths, type StackPaths } from './versions/stackPaths.js';
import { missingStackSecrets, type StackSecrets } from './versions/stackSecrets.js';
import type {
  StackVersionRecord,
  StackVersionRepository,
} from './versions/StackVersionRepository.js';

const logger = Logger.getInstance();

const STDERR_TAIL_BYTES = 4096;
const STDOUT_TAIL_BYTES = 4096;

/**
 * Every config file of the engine in the directory except `keep`, gone. A
 * missing directory is nothing to do.
 *
 * Run after the recreate and not before it. A container that is crash looping
 * on the old file is restarted by Docker until compose replaces it, and Docker
 * restarts a container whose bind-mounted file has vanished by creating a
 * directory of that name in its place. Pruning first left exactly such a
 * directory behind on the host on 2026-09-07. Recursive, so that a directory
 * left by an earlier pass goes too.
 */
async function removeStaleEngineConfigs(
  dir: string,
  engine: EngineName,
  keep: string | null,
): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (name === keep || !isEngineConfigFile(engine, name)) continue;
    await rm(join(dir, name), { recursive: true, force: true });
  }
}

function stripDockerWarnings(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/\blevel=(warning|info)\b/.test(line))
    .join('\n');
}

interface JobConfig {
  profileName: string;
  paths: StackPaths;
  script: string;
  args: string[];

  transitionTo?: ProfileStatus;

  allowedFrom?: readonly ProfileStatus[];

  /** For a job that creates containers: the guard it holds while it runs. */
  guard?: { kind: DeployAttemptKind; services: readonly string[] };

  onSuccess: () => Promise<void>;
}

const REDEPLOY_STATUS: ProfileStatus = 'DEPLOYING';
const REDEPLOYABLE_FROM: readonly ProfileStatus[] = [
  'RUNNING',
  'STOPPED',
  'ERROR',
];

/**
 * A claim on a profile's next deployment.
 *
 * Holding one is what makes a caller the owner: the profile is already in
 * DEPLOYING, so a second caller is refused before it writes a setting or an env
 * file. Nothing that changes stored state may run before the claim is taken,
 * and from then until the job finishes only the orchestrator marks the profile
 * ERROR.
 */
export interface DeployReservation {
  readonly profileName: string;
  /** What the run will start, after the stamp hold-back. */
  readonly services: readonly string[];
  readonly heldBackForStamp: readonly string[];
  /**
   * The status the profile held when the claim was taken.
   * `cancelReservation` puts it back to this.
   */
  readonly previousStatus: ProfileStatus;
  /** False for an initial deploy, whose row was inserted DEPLOYING already. */
  readonly transitioned: boolean;
  readonly host?: string;
}

/**
 * Whatever must hold before a stream-uploader container is started.
 *
 * Implemented by `UploaderStartGate`. Kept as an interface here so the
 * orchestrator depends on the question, not on the services that answer it, and
 * so a caller wired without one deploys exactly as it did before.
 */
export interface UploaderGate {
  assertCanStart(profile: Profile): Promise<void>;
}

export class DeploymentOrchestrator {
  constructor(
    private readonly profiles: ProfileRepository,
    private readonly containers: ContainerRepository,
    private readonly runner: ScriptRunner,
    private readonly eventBus: EventBus,
    private readonly groups: DeploymentGroupRepository,
    private readonly versions: StackVersionRepository,
    private readonly attempts: DeployAttemptRepository,
    private readonly daemon: DaemonObserver,
    private readonly uploaderGate?: UploaderGate,
  ) {}

  /**
   * Whether a deploy of the profile may start now, asked before the claim
   * so a refusal changes nothing. The guard itself is taken when the job
   * starts, under the daemon's lock, which is what decides.
   */
  private async assertAttemptAdmissible(profile: Profile, kind: DeployAttemptKind): Promise<void> {
    const daemonId = await this.daemon.daemonId();
    const refusal = whyAdmissionIsRefused(
      { daemonId, project: profile.name, kind },
      await this.attempts.listUnresolved(daemonId),
    );
    if (refusal) throw new DeployAttemptRefusedError(profile.name, refusal);
  }

  /** Shared tags, unless the version's contract says its built services name no image. Unknown is shared. */
  private async attemptKindFor(profile: Profile): Promise<DeployAttemptKind> {
    const version = await this.versionFor(profile);
    return version?.contract?.features?.sharedImageTags === false ? 'fixed' : 'shared';
  }

  /** Every attempt still holding a project or the daemon here, for the pages. */
  async unresolvedAttempts(): Promise<DeployAttempt[]> {
    return this.attempts.listUnresolved(await this.daemon.daemonId());
  }

  /** A removed deployment's attempts hold nothing: its containers are gone, and its name may be used again. */
  private async releaseAttemptsOf(project: string, by: string): Promise<void> {
    const released = await this.attempts.releaseProject(await this.daemon.daemonId(), project, by);
    if (released.length === 0) return;
    logger.info(`[Orchestrator] released ${released.map((attempt) => attempt.jobId).join(', ')} of ${project}: ${by}`);
    this.eventBus.publish({ type: 'attempt.changed' });
  }

  /** A blocked attempt released by a person who checked the host. */
  async releaseAttempt(id: number, by: string): Promise<DeployAttempt | null> {
    const released = await this.attempts.release(id, by);
    if (released) {
      logger.info(`[Orchestrator] attempt ${released.jobId} on ${released.project} released by ${by}`);
      this.eventBus.publish({ type: 'attempt.changed' });
    }
    return released;
  }

  /**
   * What boot does with the attempts a gone manager left open: each is
   * judged by its project's containers now, released when every touched
   * service shows a new one and blocked otherwise. Never by time.
   */
  async reconcileAttempts(): Promise<{ released: string[]; blocked: string[] }> {
    const outcome = { released: [] as string[], blocked: [] as string[] };
    const daemonId = await this.daemon.daemonId();
    for (const attempt of await this.attempts.listUnresolved(daemonId)) {
      if (attempt.state !== 'open') continue;
      const judged = attemptOutcome(attempt, await this.daemon.containerIdsOf(attempt.project));
      await this.attempts.resolve(attempt.id, judged);
      (judged.state === 'released' ? outcome.released : outcome.blocked).push(attempt.project);
    }
    if (outcome.blocked.length > 0) {
      logger.warn(`[Orchestrator] deploy attempts left blocked at boot: ${outcome.blocked.join(', ')}`);
    }
    return outcome;
  }

  /**
   * The version this deployment runs, or null when its row is gone, which the
   * deploy treats as the bundled version rather than refusing to run.
   */
  private async versionFor(profile: Profile): Promise<StackVersionRecord | null> {
    const version = await this.versions.findById(profile.stack_version_id);
    if (!version) {
      logger.warn(
        `[Orchestrator] ${profile.name} names stack version ${profile.stack_version_id}, which is gone. Using the bundled checkout.`,
      );
    }
    return version;
  }

  /**
   * The checkout this deployment runs against. Every script, env file and
   * bootstrap copy comes from here, so moving a deployment to another version
   * is a different root and nothing else.
   */
  private async pathsFor(profile: Profile): Promise<StackPaths> {
    return stackPaths((await this.versionFor(profile)) ?? { rootPath: null });
  }

  /**
   * The secrets this version's containers refuse to start without, generated
   * the first time the deployment runs on it and kept from then on.
   *
   * Generated at deploy rather than at creation, so a version whose contract
   * grows a secret on Update is covered by the next deploy of every deployment
   * on it, with nothing to migrate.
   */
  private async stackSecretsFor(
    profile: Profile,
    version: StackVersionRecord | null,
  ): Promise<StackSecrets> {
    const required = version?.contract?.requiredSecrets ?? [];
    if (required.length === 0) return {};

    const stored = await this.profiles.stackSecretsOf(profile.name);
    const generated = missingStackSecrets(required, stored);
    if (Object.keys(generated).length > 0) {
      await this.profiles.storeStackSecrets(profile.name, generated);
      logger.info(
        `[Orchestrator] ${profile.name}: generated ${Object.keys(generated).join(', ')} for ${version?.name}`,
      );
    }

    const secrets: StackSecrets = {};
    for (const key of required) {
      secrets[key] = generated[key] ?? stored[key]!;
    }
    return secrets;
  }

  /**
   * Writes the deployment's own engine config into its data directory, where
   * the version's compose override mounts it from, and answers the path. Null
   * when the template runs. The file's name carries a hash of its content, see
   * `engineConfigFileName`. Older files of that engine are left in place until
   * the recreate has succeeded, see `removeStaleEngineConfigs`.
   */
  private async engineConfigFileFor(
    profile: Profile,
    engine: EngineName,
    version: StackVersionRecord | null,
  ): Promise<string | null> {
    const supported = version?.contract?.engineConfig[engine] ?? false;
    const config = supported
      ? await this.profiles.engineConfigOf(profile.name)
      : null;
    if (config === null) return null;

    const dir = engineConfigDirFor(profile.name);
    const path = join(dir, engineConfigFileName(engine, config));
    await mkdir(dir, { recursive: true });
    await writeFile(path, config, 'utf8');
    return path;
  }

  /** The checkout root this deployment's env file is built from. */
  async stackRootFor(profile: Profile): Promise<string> {
    return (await this.pathsFor(profile)).root;
  }

  private async publishChanged(profile: Profile): Promise<void> {
    const withContainers = await this.containers.withContainers(profile);
    this.eventBus.publish({ type: 'profile.changed', profile: withContainers });
  }

  /**
   * Claims a redeploy of an existing profile, or throws ProfileBusyError.
   *
   * Callers that write before deploying take the claim first and pass it to
   * `runReserved`, so a caller that loses the race changes nothing.
   */
  async reserveDeploy(
    profile: Profile,
    requested: string[] | undefined,
  ): Promise<DeployReservation> {
    const planned = this.planDeploy(profile, requested);

    await this.assertUploaderCanStart(profile, planned.services);
    await this.assertAttemptAdmissible(profile, await this.attemptKindFor(profile));

    const transitioned = await this.profiles.transitionStatus(
      profile.name,
      REDEPLOY_STATUS,
      REDEPLOYABLE_FROM,
    );
    if (!transitioned) {
      const current = await this.profiles.findByName(profile.name);
      throw new ProfileBusyError(profile.name, current?.status ?? 'REMOVING');
    }
    await this.publishChanged(transitioned);

    return { ...planned, transitioned: true };
  }

  /** Gives the profile its status back, for a claim that will not be run. */
  async cancelReservation(reservation: DeployReservation): Promise<void> {
    if (!reservation.transitioned) return;
    const restored = await this.profiles.markTerminal(
      reservation.profileName,
      reservation.previousStatus,
    );
    if (restored) {
      await this.publishChanged(restored);
    }
  }

  /**
   * Writes the profile's env file and starts the deploy script.
   *
   * Every failure from here on marks the profile ERROR, because the claim taken
   * by `reserveDeploy` left it DEPLOYING and only this call can end that.
   */
  async runReserved(
    reservation: DeployReservation,
    profile: Profile,
  ): Promise<RunHandle> {
    try {
      return await this.startReservedJob(reservation, profile);
    } catch (err) {
      // The guard is taken under the daemon's lock when the job starts, and
      // a deploy that passed the check a moment earlier can lose it there.
      // That is a refusal, not a failure: a claimed deployment gets its
      // status back. One that exists for this deploy alone has no status to
      // go back to and is marked failed with the reason, like any failure.
      if (err instanceof DeployAttemptRefusedError && reservation.transitioned) {
        await this.cancelReservation(reservation);
        throw err;
      }
      await this.markFailed(reservation.profileName, getErrorMessage(err));
      throw err;
    }
  }

  async startDeploy(
    profile: Profile,
    requested: string[] | undefined,
  ): Promise<RunHandle> {
    const reservation = await this.reserveDeploy(profile, requested);
    return this.runReserved(reservation, profile);
  }

  async startInitialDeploy(
    profile: Profile,
    requested: string[] | undefined,
    opts: { host?: string } = {},
  ): Promise<RunHandle> {
    // The row was inserted DEPLOYING for this call, so there is no status to
    // claim: nothing else can be deploying a profile that did not exist yet.
    return this.runReserved(
      this.planDeploy(profile, requested, opts.host),
      profile,
    );
  }

  async startDeployUploader(profile: Profile): Promise<RunHandle> {
    // A pool-backed uploader pays with the pool's batches, not its own.
    if (!hasStampId(profile) && !hasBeePublishers(profile)) {
      throw new StampRequiredError(profile.name);
    }
    const reservation = await this.reserveDeploy(profile, [
      STREAM_UPLOADER_SERVICE,
    ]);
    return this.runReserved(reservation, profile);
  }

  private servicesToDeploy(
    profile: Profile,
    requested: string[] | undefined,
  ): string[] {
    if (requested && requested.length > 0) return requested;
    return defaultServicesFor(profile);
  }

  private planDeploy(
    profile: Profile,
    requested: string[] | undefined,
    host?: string,
  ): DeployReservation {
    const { deployNow, heldBackForStamp } = splitDeployableServices(
      profile,
      this.servicesToDeploy(profile, requested),
    );
    return {
      profileName: profile.name,
      services: deployNow,
      heldBackForStamp,
      previousStatus: profile.status,
      transitioned: false,
      host,
    };
  }

  /**
   * Asks the gate whether this deploy may recreate the stream-uploader.
   *
   * Only where there is something to ask. A STOPPED deployment's Bee node is
   * down by definition and an initial deploy has no node yet, so a question
   * put to the node could only time out. A profile that publishes through a
   * node pool or an external address has no node of its own to ask either.
   */
  private async assertUploaderCanStart(
    profile: Profile,
    services: readonly string[],
  ): Promise<void> {
    if (!this.uploaderGate) return;
    if (!services.includes(STREAM_UPLOADER_SERVICE)) return;
    if (!ownsBeeNode(profile)) return;
    if (profile.status !== 'RUNNING' && profile.status !== 'ERROR') return;
    await this.uploaderGate.assertCanStart(profile);
  }

  private async markFailed(
    profileName: string,
    message: string,
  ): Promise<void> {
    try {
      const errored = await this.profiles.markError(profileName, message);
      if (errored) {
        await this.publishChanged(errored);
      }
    } catch (err) {
      logger.error(
        `[Orchestrator] failed to mark ${profileName} ERROR: ${getErrorMessage(err)}`,
      );
    }
  }

  private async startReservedJob(
    reservation: DeployReservation,
    profile: Profile,
  ): Promise<RunHandle> {
    if (reservation.heldBackForStamp.length > 0) {
      logger.info(
        `[Orchestrator] ${profile.name}: holding back ${reservation.heldBackForStamp.join(', ')}, no usable stamp yet`,
      );
    }

    // An empty service filter would make deploy.sh deploy every configured service.
    if (reservation.services.length === 0) {
      return this.completeWithoutScript(profile);
    }

    const version = await this.versionFor(profile);
    const paths = stackPaths(version ?? { rootPath: null });
    await this.ensureStackDefaults(paths);

    // .env.<profile> carries the per-profile keys deploy.sh reads from its env
    // file: ENGINE selects the uploader's engine plugin (and OME ports when
    // engine=ome), and a non-empty STAMP skips the interactive stamp prompt.
    const engine = engineForComponents(profile.components);
    const engineConfigFile = await this.engineConfigFileFor(profile, engine, version);
    const written = writeProfileEnv(paths.root, profile.name, {
      engine,
      stampId: profile.stamp_id,
      beePublishers: profile.bee_publishers,
      beeUrl: profile.bee_url,
      srtPassphrase: profile.srt_passphrase,
      streamKey: profile.private_key,
      engineSettings: profile.engine_settings,
      stackSecrets: await this.stackSecretsFor(profile, version),
      stackEngineDefaults: version?.contract?.engineDefaults,
      engineConfigFile,
      // From the profile's own components, deliberately not from the reserved
      // services: a held-back uploader is deployed on its own, and deploy.sh
      // must still resolve the local Bee address for it.
      localBeeUploader: ownsBeeNode(profile),
      ...omePortsFor(profile.port_slot, portTableOf(version?.contract)),
    });
    logger.info(
      `[Orchestrator] ${profile.name}: wrote profile env ${written} (engine=${engine})`,
    );

    const services = [...reservation.services];
    return this.runJob({
      profileName: profile.name,
      paths,
      script: paths.deploy,
      args: this.buildScriptArgs(profile, services, reservation.host),
      guard: { kind: await this.attemptKindFor(profile), services },
      onSuccess: async () => {
        await this.snapshotContainers(profile, paths, version, services, engineConfigFile);
        await removeStaleEngineConfigs(
          engineConfigDirFor(profile.name),
          engine,
          engineConfigFile === null ? null : basename(engineConfigFile),
        );
        // Last, because RUNNING is what tells everyone the deploy is over.
        const updated = await this.profiles.markTerminal(
          profile.name,
          'RUNNING',
        );
        if (updated) {
          await this.publishChanged(updated);
        }
      },
    });
  }

  private async completeWithoutScript(profile: Profile): Promise<RunHandle> {
    await this.ensureStackDefaults(await this.pathsFor(profile));

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
    const paths = await this.pathsFor(profile);
    return this.runJob({
      profileName: profile.name,
      paths,
      script: paths.stop,
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

    const paths = await this.pathsFor(profile);
    return this.runJob({
      profileName: profile.name,
      paths,
      script: paths.clean,
      args,
      transitionTo: 'REMOVING',
      allowedFrom: ['RUNNING', 'STOPPED', 'ERROR'],
      onSuccess: async () => {
        // First, so a failure here keeps the deployment and its attempts
        // together for another try, and the name is free once the row goes.
        await this.releaseAttemptsOf(profile.name, 'removed with the deployment');
        await this.removeProfileDataDir(profile.name);
        await this.profiles.deleteByName(profile.name);
        deleteProfileEnv(paths.root, profile.name);
        this.eventBus.publish({ type: 'profile.deleted', name: profile.name });
        logger.info(
          `[Orchestrator] Removed profile ${profile.name} (released slot ${profile.port_slot})`,
        );

        await this.cleanupGroup(profile.group_id);
      },
    });
  }

  private async cleanupGroup(groupId: number | null): Promise<void> {
    if (groupId != null) {
      try {
        const outcome = await this.groups.syncMembershipAfterRemoval(groupId);
        if (outcome === 'deleted') {
          logger.info(
            `[Orchestrator] Removed empty group ${groupId} after its last member left`,
          );
        }
      } catch (err) {
        logger.warn(
          `[Orchestrator] could not reconcile group ${groupId}: ${getErrorMessage(err)}`,
        );
      }
    }
  }

  async startHealth(profile: Profile): Promise<RunHandle> {
    const paths = await this.pathsFor(profile);
    await this.ensureStackDefaults(paths);
    return this.runner.run(paths.health, this.buildScriptArgs(profile, []), {
      cwd: paths.root,
      env: beeDataDirsFor(profile.name),
    });
  }

  // rsync --delete on deploy wipes these gitignored files; recreate before every script run.
  private async ensureStackDefaults(paths: StackPaths): Promise<void> {
    const created = await bootstrapStackDefaults(paths.root);
    for (const file of created) {
      logger.info(`[Orchestrator] created missing default: ${file}`);
    }
  }

  private async runJob(cfg: JobConfig): Promise<RunHandle> {
    await this.ensureStackDefaults(cfg.paths);

    if (cfg.transitionTo && cfg.allowedFrom) {
      const transitioned = await this.profiles.transitionStatus(
        cfg.profileName,
        cfg.transitionTo,
        cfg.allowedFrom,
      );
      if (!transitioned) {
        const current = await this.profiles.findByName(cfg.profileName);
        throw new ProfileBusyError(
          cfg.profileName,
          current?.status ?? 'REMOVING',
        );
      }
      await this.publishChanged(transitioned);
    }

    // The guard, before anything is spawned: the project's containers as they
    // are, so what the attempt creates can be told from what was there.
    let attempt: DeployAttempt | null = null;
    if (cfg.guard) {
      const daemonId = await this.daemon.daemonId();
      const before = await this.daemon.containerIdsOf(cfg.profileName);
      attempt = await this.attempts.open({
        daemonId,
        project: cfg.profileName,
        jobId: `job-${randomBytes(6).toString('hex')}`,
        kind: cfg.guard.kind,
        services: cfg.guard.services,
        preJobContainerIds: [...before.values()].flat(),
      });
      this.eventBus.publish({ type: 'attempt.changed' });
    }

    logger.info(
      `[Orchestrator] ${cfg.profileName} running: bash ${cfg.script} ${describeArgsForLog(cfg.args)}`,
    );

    const handle = this.runner.run(cfg.script, cfg.args, {
      cwd: cfg.paths.root,
      env: beeDataDirsFor(cfg.profileName),
    });

    let stderrTail = '';
    let stdoutTail = '';
    handle.emitter.on('stderr', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    handle.emitter.on('stdout', (chunk: string) => {
      stdoutTail = (stdoutTail + chunk).slice(-STDOUT_TAIL_BYTES);
    });

    handle.emitter.on('done', ({ code }: { code: number }) => {
      void (async () => {
        if (attempt) await this.judgeAttempt(attempt);
        await this.finalizeJob(cfg, code, stderrTail, stdoutTail);
      })();
    });
    // A script that never started ends the attempt the same way: nothing new
    // was created, so it blocks, and the host is not held open for nothing.
    handle.emitter.on('error', (err: Error) => {
      void (async () => {
        if (attempt) await this.judgeAttempt(attempt);
        await this.finalizeJob(cfg, -1, err.message, stdoutTail);
      })();
    });

    return handle;
  }

  /**
   * The attempt is judged by its project's containers the moment the script
   * ends, whatever the exit code: released when every touched service shows
   * a new container, blocked naming the rest. A daemon that does not answer
   * leaves it open for boot to judge.
   */
  private async judgeAttempt(attempt: DeployAttempt): Promise<void> {
    try {
      const judged: AttemptOutcome = attemptOutcome(attempt, await this.daemon.containerIdsOf(attempt.project));
      await this.attempts.resolve(attempt.id, judged);
      if (judged.state === 'blocked') {
        logger.warn(`[Orchestrator] attempt ${attempt.jobId} on ${attempt.project} is blocked: ${judged.reason}`);
      }
      this.eventBus.publish({ type: 'attempt.changed' });
    } catch (err) {
      logger.warn(
        `[Orchestrator] could not judge attempt ${attempt.jobId} on ${attempt.project}: ${getErrorMessage(err)}. It stays open until the next boot judges it.`,
      );
    }
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
        stripDockerWarnings(stderrTail).trim() ||
        stdoutTail.trim() ||
        stderrTail.trim() ||
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
      await this.markFailed(cfg.profileName, message);
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
    if (profile.stamp_id) args.push(`--stamp-id=${profile.stamp_id}`);
    args.push(...services);
    return args;
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
    paths: StackPaths,
    version: StackVersionRecord | null,
    services: string[],
    engineConfigFile: string | null,
  ): Promise<void> {
    try {
      const env = this.buildEffectiveEnv(profile, paths, version);
      if (engineConfigFile) {
        env[ENGINE_CONFIG_ENV_KEYS[engineForComponents(profile.components)]] =
          engineConfigFile;
      }
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

  /**
   * The environment the containers were started with, as far as the manager
   * can tell without asking Docker: the base env of the version's checkout,
   * the version's port table shifted by the slot the way `deploy.sh` shifts
   * it, and the per profile values `.env.<profile>` carries.
   */
  private buildEffectiveEnv(
    profile: Profile,
    paths: StackPaths,
    version: StackVersionRecord | null,
  ): Record<string, string> {
    const env = parseBaseEnv(paths.root);

    Object.assign(env, beeDataDirsFor(profile.name));

    env.ENGINE = engineForComponents(profile.components);

    const table = portTableOf(version?.contract);
    for (const port of table) {
      if (profile.port_slot === 0) {
        if (env[port.name] === undefined || env[port.name] === '') {
          env[port.name] = String(port.defaultPort);
        }
      } else {
        env[port.name] = String(portFor(port, profile.port_slot));
      }
    }
    if (env.API_PORT) {
      env.SRS_ADAPTER_PORT = env.API_PORT;
      env.OME_ADAPTER_PORT = env.API_PORT;
    }

    const omePorts = omePortsFor(profile.port_slot, table);
    if (omePorts.omeSrtPort) env.OME_SRT_PORT = String(omePorts.omeSrtPort);
    if (omePorts.omeHlsPort) env.OME_HLS_PORT = String(omePorts.omeHlsPort);

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
    // Same keys writeProfileEnv puts in .env.<profile>, so the container
    // snapshot shows what a pool-backed uploader was actually started with.
    const publishers = profile.bee_publishers?.trim();
    if (publishers) {
      env.BEE_PUBLISHERS = publishers;
      env.ABR_ENABLED = 'true';
      env.ABR_LADDER = abrLadderEnvValue();
    }
    const beeUrl = profile.bee_url?.trim();
    if (beeUrl && !publishers) {
      env.BEE_URL = beeUrl;
    }
    // Unset leaves the base .env's value in place, matching writeProfileEnv.
    if (profile.srt_passphrase) {
      env.SRT_PASSPHRASE = profile.srt_passphrase;
    }
    Object.assign(
      env,
      engineSettingsEnv(
        engineForComponents(profile.components),
        profile.engine_settings,
      ),
    );

    return env;
  }
}
