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
  portExposureProblem,
  slotCapFor,
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
import { DeployAttemptRefusedError, ProfileBusyError, ProfileConfigError, ReservationInventoryPendingError, StampRequiredError, TargetNotVerifiedError } from './errors/index.js';
import type { PortReservationRepository } from './ports/PortReservationRepository.js';
import { PortHandover } from './ports/PortHandover.js';
import type { PublishedPortsProbe } from './ports/PublishedPortsProbe.js';
import { portKeyOf, portPlanFor } from './ports/portReservations.js';
import { portTableForEngine } from './versions/enginePortTable.js';
import { targetAlias, type DeployTargets } from './ports/DeployTargets.js';
import {
  type AttemptOutcome,
  type DeployAttempt,
  type DeployAttemptKind,
  attemptOutcome,
  whyAdmissionIsRefused,
} from './deployAttempts.js';
import type { DaemonObserver, DeployAttemptRepository } from './DeployAttemptRepository.js';
import type { EngineConfigOperationRepository } from './engineConfig/EngineConfigOperationRepository.js';
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
import { deployOwnerOf, type BuildDescriptor, type BuildLedger, type DeployClaimOwnership, type Observation } from './versions/buildLedger.js';
import {
  deployRootProblem,
  stackPaths,
  type StackPaths,
  stackPathsForRoot,
} from './versions/stackPaths.js';
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

/**
 * Runs what a caller asked to run once its deploy settled, and keeps the
 * hook's failure to itself. The deploy's own outcome is committed by then, so
 * a hook that throws must not turn a RUNNING row into an ERROR one or replace
 * the script's own reason with its own.
 */
async function runHook(when: string, hook: () => Promise<void> | undefined): Promise<void> {
  try {
    await hook();
  } catch (err) {
    logger.error(`[Orchestrator] the hook ${when} failed: ${getErrorMessage(err)}`);
  }
}

/** What a caller asks to run once the deploy it started has settled. */
export interface DeployHooks {
  /** After RUNNING is committed, which is when a watch on the result may begin. */
  afterRunning?: () => Promise<void>;
  /** After the script failed and the deployment was marked ERROR with the message. */
  afterFailure?: (message: string) => Promise<void>;
}

interface JobConfig {
  profileName: string;
  target: string;
  reservedDaemonId?: string;
  paths: StackPaths;
  script: string;
  args: string[];

  transitionTo?: ProfileStatus;

  allowedFrom?: readonly ProfileStatus[];

  /** For a job that creates containers: the guard it holds while it runs. */
  guard?: { kind: DeployAttemptKind; services: readonly string[] };

  beforeRun?: () => Promise<void>;

  onLaunch?: () => void;

  onSuccess: (attempt: DeployAttempt | null) => Promise<void>;
  /** Runs once the status claim is committed, before the script starts. */
  afterClaim?: () => Promise<void>;

  onFailure?: (message: string) => Promise<void>;
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
  readonly claimedProfile?: Profile;
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
  readonly daemonId?: string;
  /**
   * The build the run will deploy from, captured with the claim. Null only
   * for a reservation made without one, which the run describes itself.
   */
  readonly build: BuildDescriptor | null;
}

type CapturedDeployReservation = DeployReservation & {
  readonly build: BuildDescriptor & { version: StackVersionRecord };
};

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
    private readonly ledger: BuildLedger,
    private readonly attempts: DeployAttemptRepository,
    private readonly daemon: DaemonObserver,
    private readonly operations: EngineConfigOperationRepository,
    private readonly uploaderGate?: UploaderGate,
    private readonly targets?: DeployTargets,
    private readonly ports?: PortReservationRepository,
    private readonly portObserver?: PublishedPortsProbe,
    private readonly inventoryTargets?: DeployTargets,
  ) {}

  /**
   * Whether a deploy of the profile may start now, asked before the claim
   * so a refusal changes nothing. The guard itself is taken when the job
   * starts, under the daemon's lock, which is what decides.
   */
  private async assertAttemptAdmissible(profile: Profile, kind: DeployAttemptKind): Promise<void> {
    const daemonId = await this.targetDaemon(targetAlias(profile.host));
    const refusal = whyAdmissionIsRefused(
      { daemonId, project: profile.name, kind },
      await this.attempts.listUnresolved(daemonId),
    );
    if (refusal) throw new DeployAttemptRefusedError(profile.name, refusal);
  }

  private async targetDaemon(target: string): Promise<string> {
    const actual = await this.daemon.daemonId(target);
    if (this.targets && actual !== await this.targets.daemonIdFor(target)) {
      throw new TargetNotVerifiedError(target, 'This target reaches a different Docker daemon than its reservations. Verify it before deploying.');
    }
    return actual;
  }

  /** Shared tags, unless the version's contract says its built services name no image. Unknown is shared. */
  private attemptKindOf(version: StackVersionRecord | null): DeployAttemptKind {
    return version?.contract?.features?.sharedImageTags === false ? 'fixed' : 'shared';
  }

  /** Every attempt still holding a project or the daemon here, for the pages. */
  async unresolvedAttempts(): Promise<DeployAttempt[]> {
    return this.attempts.listUnresolved();
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
    for (const attempt of await this.attempts.listUnresolved()) {
      if (attempt.state !== 'open') continue;
      const judged = await this.judgeAttempt(attempt);
      if (!judged) continue;
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

  private deployVersionOrThrow(profile: Profile, version: StackVersionRecord | null): StackVersionRecord {
    if (!version) {
      throw new ProfileConfigError(profile.name, `Stack version ${profile.stack_version_id} no longer exists. Restore the version before deploying. No deployment was started.`);
    }
    return version;
  }

  private async versionForDeploy(profile: Profile): Promise<StackVersionRecord> {
    return this.deployVersionOrThrow(profile, await this.versions.findById(profile.stack_version_id));
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
    return this.claim(profile, requested, 'advance');
  }

  /**
   * The claim a config file rollout takes: the same claim, without moving the
   * intent. A rollout is not the operator acting on the deployment, and its
   * own writes are conditional on the intent it started under.
   */
  async reserveForRollout(
    profile: Profile,
    engine: EngineName,
  ): Promise<DeployReservation> {
    return this.claim(profile, [engine], 'preserve');
  }

  /**
   * An operator acted on the deployment, so a config file rollout under way
   * is over, durably: the intent it started under moves, and its open
   * operation closes with the reason. After the claim, never before it, so a
   * refused action moves nothing.
   */
  private async operatorActed(profile: Profile, reason: string): Promise<void> {
    await this.profiles.bumpIntent(profile.name);
    await this.operations.supersedeOpen(profile.instance_id, reason);
  }

  private async claim(
    profile: Profile,
    requested: string[] | undefined,
    intent: DeployClaimOwnership['intent'],
  ): Promise<DeployReservation> {
    const planned = this.planDeploy(profile, requested);

    await this.assertUploaderCanStart(profile, planned.services);
    await this.assertAttemptAdmissible(profile, this.attemptKindOf(await this.versionFor(profile)));

    // What the deploy will run is decided here, once. A version whose build
    // is missing is refused before anything is claimed, naming the build,
    // and never falls back to another root.
    const version = await this.versionForDeploy(profile);
    const problem = deployRootProblem(version);
    if (problem) throw new ProfileConfigError(profile.name, problem);

    const claimed = await this.ledger.claim(
      profile.name,
      REDEPLOYABLE_FROM,
      version,
      planned.services,
      { ...deployOwnerOf(profile), intent, supersedeReason: 'Redeployed by the operator before the file was verified.' },
    );
    if (!claimed) {
      const current = await this.profiles.findByName(profile.name);
      throw new ProfileBusyError(profile.name, current?.status ?? 'REMOVING');
    }
    const reservation = { ...planned, previousStatus: claimed.previousStatus, transitioned: true,
      claimedProfile: claimed.profile, build: claimed.descriptor };
    try {
      const daemonId = await this.reservePorts(claimed.profile, reservation);
      await this.publishChanged(claimed.profile);
      return { ...reservation, daemonId };
    } catch (err) {
      await this.cancelReservation(reservation);
      throw err;
    }
  }

  private async reservePorts(profile: Profile, reservation: DeployReservation): Promise<string> {
    const contract = reservation.build?.version?.contract;
    if (!contract?.ports.length || contract.allocationProblem) {
      throw new ProfileConfigError(profile.name, contract?.allocationProblem ?? 'The captured build has no readable port table. Rebuild the version before deploying.');
    }
    const plan = portPlanFor(portTableForEngine(contract, engineForComponents(profile.components)), profile.port_slot);
    const exposureProblem = plan.map(portExposureProblem).find(problem => problem !== null);
    if (exposureProblem) throw new ProfileConfigError(profile.name, exposureProblem);
    if (profile.port_slot < 1 || profile.port_slot > slotCapFor(contract)) {
      throw new ProfileConfigError(profile.name, `Slot ${profile.port_slot} is outside the supported range 1 to ${slotCapFor(contract)}. Existing resources were retained.`);
    }
    if (!await this.ports?.inventorySeededAt()) throw new ReservationInventoryPendingError();
    const target = targetAlias(reservation.host ?? profile.host);
    const daemonId = await this.targetDaemon(target);
    if (this.inventoryTargets && await this.inventoryTargets.daemonIdFor(target) !== daemonId) {
      throw new TargetNotVerifiedError(target, 'The inventory belongs to a different Docker daemon. No deploy was started.');
    }
    if (reservation.daemonId && reservation.daemonId !== daemonId) {
      throw new TargetNotVerifiedError(target, 'The reserved ports belong to a different Docker daemon. No deploy was started.');
    }
    await this.ports!.plan(
      daemonId, profile.name, plan,
      `build ${reservation.build!.buildId}, job reference ${reservation.build!.referenceId}`,
    );
    return daemonId;
  }

  /** Gives the profile its status back, for a claim that will not be run. */
  async cancelReservation(reservation: DeployReservation): Promise<void> {
    if (!reservation.transitioned) return;
    if (!reservation.claimedProfile || reservation.build?.referenceId == null) return;
    const restored = await this.ledger.cancelClaim(reservation.claimedProfile, reservation.build.referenceId, reservation.previousStatus);
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
    hooks: DeployHooks = {},
  ): Promise<RunHandle> {
    let prepared = reservation;
    try {
      const build = reservation.build ?? await this.ledger.describe(
        profile.name, await this.versionForDeploy(profile), [...reservation.services], deployOwnerOf(profile),
      );
      const version = this.deployVersionOrThrow(profile, build.version);
      const captured: CapturedDeployReservation = { ...reservation,
        claimedProfile: reservation.claimedProfile ?? (reservation.build === null ? profile : undefined),
        build: { ...build, version } };
      prepared = captured;
      return await this.startReservedJob(captured, profile, hooks);
    } catch (err) {
      // The guard is taken under the daemon's lock when the job starts, and
      // a deploy that passed the check a moment earlier can lose it there.
      // That is a refusal, not a failure: a claimed deployment gets its
      // status back. One that exists for this deploy alone has no status to
      // go back to and is marked failed with the reason, like any failure.
      if (err instanceof DeployAttemptRefusedError && prepared.transitioned) {
        await this.cancelReservation(prepared);
        throw err;
      }
      await this.markFailed(prepared.profileName, getErrorMessage(err));
      throw err;
    }
  }

  async startDeploy(
    profile: Profile,
    requested: string[] | undefined,
  ): Promise<RunHandle> {
    const reservation = await this.reserveDeploy(profile, requested);
    return this.runReserved(reservation, reservation.claimedProfile ?? profile);
  }

  async startInitialDeploy(
    profile: Profile,
    requested: string[] | undefined,
    opts: { host?: string } = {},
  ): Promise<RunHandle> {
    // The row was inserted DEPLOYING for this call, so there is no status to
    // claim: nothing else can be deploying a profile that did not exist yet.
    // The build is still captured here, with its reference, for the same
    // reason a claim captures it.
    let reservation: DeployReservation;
    try {
      const planned = this.planDeploy(profile, requested, opts.host);
      const version = await this.versionForDeploy(profile);
      const problem = deployRootProblem(version);
      if (problem) throw new ProfileConfigError(profile.name, problem);
      const build = await this.ledger.describe(profile.name, version, planned.services, deployOwnerOf(profile));
      reservation = { ...planned, build };
    } catch (err) {
      await this.markFailed(profile.name, getErrorMessage(err));
      throw err;
    }
    return this.runReserved(reservation, profile);
  }

  async startDeployUploader(profile: Profile): Promise<RunHandle> {
    // A pool-backed uploader pays with the pool's batches, not its own.
    if (!hasStampId(profile) && !hasBeePublishers(profile)) {
      throw new StampRequiredError(profile.name);
    }
    const reservation = await this.reserveDeploy(profile, [
      STREAM_UPLOADER_SERVICE,
    ]);
    return this.runReserved(reservation, reservation.claimedProfile ?? profile);
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
      build: null,
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
    reservation: CapturedDeployReservation,
    profile: Profile,
    hooks: DeployHooks,
  ): Promise<RunHandle> {
    let launchPossible = false;
    try {
      return await this.prepareReservedJob(reservation, profile, () => { launchPossible = true; }, hooks);
    } catch (err) {
      if (!launchPossible && reservation.build?.referenceId != null &&
          !(err instanceof DeployAttemptRefusedError && reservation.transitioned)) {
        await this.ledger.cancelUnstarted(profile.name, reservation.build.referenceId);
      }
      throw err;
    }
  }

  private async prepareReservedJob(
    reservation: CapturedDeployReservation,
    profile: Profile,
    onLaunch: () => void,
    hooks: DeployHooks,
  ): Promise<RunHandle> {
    const daemonId = await this.reservePorts(profile, reservation);
    if (reservation.heldBackForStamp.length > 0) {
      logger.info(
        `[Orchestrator] ${profile.name}: holding back ${reservation.heldBackForStamp.join(', ')}, no usable stamp yet`,
      );
    }

    // From the descriptor the claim captured, never from the version row
    // again: a deploy that selected build A must not read version B.
    const build = reservation.build;
    const version = build.version;
    const paths = stackPathsForRoot(build.root);

    // An empty service filter would make deploy.sh deploy every configured service.
    if (reservation.services.length === 0) {
      return this.completeWithoutScript(profile, paths, build.referenceId);
    }
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
      target: targetAlias(reservation.host ?? profile.host),
      reservedDaemonId: daemonId,
      onLaunch,
      paths,
      script: paths.deploy,
      args: this.buildScriptArgs(profile, services, reservation.host),
      guard: { kind: this.attemptKindOf(version), services },
      onSuccess: async (attempt) => {
        await this.snapshotContainers(profile, paths, version, services, engineConfigFile);
        await this.observeMounts(profile, services);
        if (attempt && this.ports && this.portObserver) {
          const claimed = await this.profiles.findByName(profile.name);
          if (claimed) {
            try {
              await new PortHandover(this.ports, this.portObserver, this.daemon).reconcile(claimed, build, attempt);
            } catch (err) {
              logger.warn(`[Orchestrator] port handover for ${profile.name} could not be verified: ${getErrorMessage(err)}. Reservations were retained.`);
            }
          }
        }
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
        await runHook('after it came up', () => hooks.afterRunning?.());
      },
      onFailure: hooks.afterFailure
        ? (message) => runHook('after it failed', () => hooks.afterFailure?.(message))
        : undefined,
    });
  }

  private async completeWithoutScript(profile: Profile, paths: StackPaths, referenceId: number | null): Promise<RunHandle> {
    await this.ensureStackDefaults(paths);
    if (referenceId !== null) {
      await this.ledger.cancelUnstarted(profile.name, referenceId);
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
    const paths = await this.pathsFor(profile);
    return this.runJob({
      profileName: profile.name,
      target: targetAlias(profile.host),
      paths,
      script: paths.stop,
      args: this.buildScriptArgs(profile, services ?? []),
      transitionTo: 'STOPPING',
      allowedFrom: ['RUNNING', 'ERROR'],
      afterClaim: () =>
        this.operatorActed(
          profile,
          'Stopped by the operator before the file was verified.',
        ),
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
    await this.assertRemovalReady(profile.name);
    const args: string[] = [
      `--profile=${profile.name}`,
      `--host=${targetAlias(profile.host)}`,
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
      target: targetAlias(profile.host),
      paths,
      script: paths.clean,
      args,
      transitionTo: 'REMOVING',
      allowedFrom: ['RUNNING', 'STOPPED', 'ERROR'],
      beforeRun: () => this.assertRemovalReady(profile.name),
      afterClaim: () =>
        this.operatorActed(profile, 'The deployment was removed.'),
      onSuccess: async () => {
        await this.verifyPortRemoval(profile);
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

  private async assertNoCreatingAttempt(profileName: string): Promise<void> {
    const unresolved = (await this.attempts.listUnresolved()).find(attempt => attempt.project === profileName);
    if (unresolved) {
      throw new ProfileConfigError(profileName, `Deploy attempt ${unresolved.jobId} is unresolved. Resolve its creation guard before removing this deployment.`);
    }
  }

  private async assertRemovalReady(profileName: string): Promise<void> {
    await this.assertNoCreatingAttempt(profileName);
    if (!this.ports || !this.portObserver) throw new ProfileConfigError(profileName, 'Port removal observation is not configured. Reservations were retained.');
    if (await this.ports.hasRemovalHold(profileName)) {
      throw new ProfileConfigError(profileName, 'An unresolved rollback or creation hold must be resolved before cleanup.');
    }
  }

  private async verifyPortRemoval(profile: Profile): Promise<void> {
    await this.assertRemovalReady(profile.name);
    if (!this.ports || !this.portObserver) throw new ProfileConfigError(profile.name, 'Port removal observation is not configured. Reservations were retained.');
    const target = targetAlias(profile.host);
    const daemonId = await this.targetDaemon(target);
    const containers = await this.daemon.snapshot(profile.name, target);
    const published = await this.portObserver.publishedPorts(target);
    if (containers.daemonId !== daemonId || published.daemonId !== daemonId) {
      throw new TargetNotVerifiedError(target, 'Removal observations came from a different Docker daemon. Reservations were retained.');
    }
    if ([...containers.containers.values()].some(ids => ids.length) || published.unverifiedProjects?.length) {
      throw new ProfileConfigError(profile.name, 'Container removal or port release could not be verified. Reservations were retained.');
    }
    const reservations = await this.ports.listByProfile(profile.name);
    const bound = new Set(published.bindings.map(portKeyOf));
    if (reservations.some(port => port.daemonId !== daemonId || bound.has(portKeyOf(port)))) {
      throw new ProfileConfigError(profile.name, 'Reserved ports are still bound or belong to another daemon. Reconcile them before removal.');
    }
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
    const daemonId = await this.targetDaemon(cfg.target);
    if (cfg.reservedDaemonId && cfg.reservedDaemonId !== daemonId) {
      throw new TargetNotVerifiedError(cfg.target, 'The reserved ports belong to a different Docker daemon. No deploy was started.');
    }
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
      await cfg.afterClaim?.();
    }

    try {
      await cfg.beforeRun?.();
    } catch (err) {
      if (cfg.transitionTo) await this.markFailed(cfg.profileName, getErrorMessage(err));
      throw err;
    }

    // The guard, before anything is spawned: the project's containers as they
    // are, so what the attempt creates can be told from what was there.
    let attempt: DeployAttempt | null = null;
    if (cfg.guard) {
      const before = await this.daemon.snapshot(cfg.profileName, cfg.target);
      if (before.daemonId !== daemonId) {
        throw new TargetNotVerifiedError(cfg.target, 'The container snapshot came from a different Docker daemon. No deploy was started.');
      }
      attempt = await this.attempts.open({
        daemonId,
        target: cfg.target,
        project: cfg.profileName,
        jobId: `job-${randomBytes(6).toString('hex')}`,
        kind: cfg.guard.kind,
        services: cfg.guard.services,
        preJobContainerIds: [...before.containers.values()].flat(),
      });
      this.eventBus.publish({ type: 'attempt.changed' });
    }

    logger.info(
      `[Orchestrator] ${cfg.profileName} running: bash ${cfg.script} ${describeArgsForLog(cfg.args)}`,
    );

    cfg.onLaunch?.();
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
        await this.finalizeJob(cfg, code, stderrTail, stdoutTail, attempt);
      })();
    });
    // A script that never started ends the attempt the same way: nothing new
    // was created, so it blocks, and the host is not held open for nothing.
    handle.emitter.on('error', (err: Error) => {
      void (async () => {
        if (attempt) await this.judgeAttempt(attempt);
        await this.finalizeJob(cfg, -1, err.message, stdoutTail, attempt);
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
  private async judgeAttempt(attempt: DeployAttempt): Promise<AttemptOutcome | null> {
    try {
      const profile = attempt.target ? null : await this.profiles.findByName(attempt.project);
      if (!attempt.target && !profile) throw new Error('The legacy attempt has no recorded target or deployment');
      const target = targetAlias(attempt.target ?? profile!.host);
      const snapshot = await this.daemon.snapshot(attempt.project, target);
      if (snapshot.daemonId !== attempt.daemonId) {
        throw new TargetNotVerifiedError(target, 'The attempt target now reaches a different Docker daemon');
      }
      const judged: AttemptOutcome = attemptOutcome(attempt, snapshot.containers);
      await this.attempts.resolve(attempt.id, judged);
      if (judged.state === 'blocked') {
        logger.warn(`[Orchestrator] attempt ${attempt.jobId} on ${attempt.project} is blocked: ${judged.reason}`);
      }
      this.eventBus.publish({ type: 'attempt.changed' });
      return judged;
    } catch (err) {
      logger.warn(
        `[Orchestrator] could not judge attempt ${attempt.jobId} on ${attempt.project}: ${getErrorMessage(err)}. It stays open until the next boot judges it.`,
      );
      return null;
    }
  }

  private async finalizeJob(
    cfg: JobConfig,
    code: number,
    stderrTail: string,
    stdoutTail: string,
    attempt: DeployAttempt | null,
  ): Promise<void> {
    try {
      if (code === 0) {
        await cfg.onSuccess(attempt);
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
      await cfg.onFailure?.(message);
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

  /**
   * Records which build each service's container was started from, as the
   * container says it, and resolves the job's reference when every service
   * it touched has been seen. A daemon that does not answer keeps the
   * reference, which is the safe side: the build stays. A row that cannot
   * be written is logged and nothing more: this runs inside the success
   * hook, and the containers are up whatever the rows managed to say.
   */
  private async observeMounts(profile: Profile, services: string[]): Promise<void> {
    let observations: Observation[];
    try {
      observations = await this.ledger.observe(profile.name, services);
    } catch (err) {
      logger.warn(
        `[Orchestrator] could not observe what ${profile.name} mounts: ${getErrorMessage(err)}. Its build reference stays open.`,
      );
      return;
    }
    try {
      for (const seen of observations) {
        await this.containers.setBuild(profile.name, seen.service, seen.buildId, seen.commit);
      }
      // One commit for the deployment only when this deploy touched every
      // service it has and every one was seen on that commit. A partial deploy
      // advances the services it touched and nothing else.
      const every = defaultServicesFor(profile);
      const agreed = observations[0]?.commit ?? null;
      const full =
        agreed !== null &&
        every.every((service) => observations.some((seen) => seen.service === service && seen.commit === agreed));
      if (full) {
        await this.profiles.setLastFullDeployCommit(profile.name, agreed);
      }
    } catch (err) {
      logger.warn(
        `[Orchestrator] could not record what ${profile.name} runs: ${getErrorMessage(err)}. The rows say what they said before.`,
      );
    }
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
