import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  abrLadderEnvValue,
  engineForComponents,
  type EngineName,
  engineSettingsEnv,
  getErrorMessage,
  gatewayNodeMode,
  ownsBeeNode,
  redactEndpoints,
  portExposureProblem,
  slotCapFor,
  ENGINE_CONFIG_ENV_KEYS,
} from '@streaming-infra-manager/common';

import { Profile, ProfileStatus } from '../types/index.js';
import {
  bootstrapStackDefaults,
  deleteProfileEnv,
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
import { DeployAttemptRefusedError, ProfileBusyError, ProfileInstanceChangedError, ProfileNotFoundError, ProfileConfigError, ReservationInventoryPendingError, StampRequiredError, TargetNotVerifiedError } from './errors/index.js';
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
import {
  allContainerIds,
  containerIdsByService,
  type DaemonObserver,
  type DeployAttemptRepository,
  type ObservedContainer,
} from './DeployAttemptRepository.js';
import type { EngineConfigOperationRepository } from './engineConfig/EngineConfigOperationRepository.js';
import type { PreparedRolloutDeploy, RolloutAdmissionProof } from './engineConfig/rolloutDeployAdmission.js';
import { EventBus } from './EventBus.js';
import { Logger } from './Logger.js';
import { ProfileRepository } from './ProfileRepository.js';
import { describeArgsForLog, type RunHandle, type RunOutcome, ScriptRunner } from './ScriptRunner.js';
import {
  defaultServicesFor,
  hasBeePublishers,
  hasStampId,
  splitDeployableServices,
  STREAM_UPLOADER_SERVICE,
} from './stampLogic.js';
import { omePortsFor, portFor, portTableOf } from './versions/portTable.js';
import { deployOwnerOf, type BuildDescriptor, type BuildLedger, type DeployClaimOwnership, type ExpectedDeployOwner, type Observation } from './versions/buildLedger.js';
import {
  deployRootProblem,
  stackPaths,
  type StackPaths,
  stackPathsForRoot,
} from './versions/stackPaths.js';
import type { ExecutionRoots, PreparedExecution } from './versions/ExecutionRootService.js';
import { missingStackSecrets, type StackSecrets } from './versions/stackSecrets.js';
import { versionSuppliedSecrets } from './versions/versionSuppliedSecrets.js';
import type {
  DeployVersionSnapshot,
  StackVersionRecord,
  StackVersionRepository,
} from './versions/StackVersionRepository.js';

const logger = Logger.getInstance();

const STDERR_TAIL_BYTES = 4096;
const STDOUT_TAIL_BYTES = 4096;

/** What a deployment that was in ERROR is told when a deploy had nothing to start. */
const NOTHING_TO_DEPLOY =
  'This deployment has no service to deploy, so nothing was started and it is as it was.';

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

/** How a run ended, and the last of what it printed on the way. */
interface JobOutcome extends RunOutcome {
  stderrTail: string;
  stdoutTail: string;
}

/**
 * Why a run that did not succeed did not, in the words an operator reads.
 *
 * A run ended by a signal has no output that explains it, because it was
 * stopped rather than refused, and its last four kilobytes of ordinary
 * progress read as though they were the failure.
 */
function failureReason(script: string, outcome: JobOutcome): string {
  if (outcome.signal) return `${script} was killed by ${outcome.signal}`;
  return (
    stripDockerWarnings(outcome.stderrTail).trim() ||
    outcome.stdoutTail.trim() ||
    outcome.stderrTail.trim() ||
    `${script} exited with code ${outcome.code}`
  );
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

/** What boot made of a row a gone manager left mid-transition, and why. */
export interface OrphanRecovery {
  status: ProfileStatus;
  /** Null where there is nothing to report, which is a deployment that is up. */
  message: string | null;
}

/** Docker's word for a container that is up. Every other state is not up. */
const RUNNING_STATE = 'running';

/** A service is up when at least one of its containers is running. */
const isUp = (observed: readonly ObservedContainer[]): boolean =>
  observed.some((container) => container.state === RUNNING_STATE);

/** Why a service does not count as up, in Docker's own word for what was found. */
const whatWasFound = (service: string, observed: readonly ObservedContainer[]): string => {
  const first = observed[0];
  return first ? `${service} has a container that is ${first.state}` : `${service} has no container`;
};

/**
 * What a deployment the manager was restarted in the middle of actually is,
 * read from what its services are doing rather than from the status it was
 * interrupted in.
 *
 * A service is up when at least one of its containers is running. A deploy or a
 * removal that left every service up is RUNNING, and one that did not is ERROR
 * naming each service that is not up and what Docker had for it instead. A stop
 * that left nothing up is STOPPED, which is what a finished `docker compose
 * stop` looks like, and one that left something up is ERROR naming it, so an
 * operator knows what to stop again.
 *
 * A removal interrupted before it removed anything therefore reads as RUNNING,
 * which is what such a deployment is. Ruled acceptable: the row is back where
 * an operator can act on it, and Remove is one click, where keeping REMOVING
 * refuses every later action as busy.
 *
 * @param expected the services the deployment runs, from its kind or its
 *   components. A deployment that names none has nothing to be judged by.
 * @param containers the project's containers by service, or null when the
 *   daemon did not answer, which keeps the older rule of marking it failed.
 */
export function orphanRecoveryOf(
  profile: Pick<Profile, 'status'>,
  expected: readonly string[],
  containers: ReadonlyMap<string, readonly ObservedContainer[]> | null,
): OrphanRecovery {
  const restarted = `The manager restarted while this deployment was ${profile.status}`;
  if (!containers) {
    return { status: 'ERROR', message: `${restarted}, and the Docker daemon did not answer, so what it left is unknown.` };
  }
  if (expected.length === 0) {
    return { status: 'ERROR', message: `${restarted}, and it runs no service whose containers could say how far it got.` };
  }
  const observedOf = (service: string): readonly ObservedContainer[] => containers.get(service) ?? [];
  const up = expected.filter((service) => isUp(observedOf(service)));
  if (profile.status === 'STOPPING') {
    if (up.length === 0) return { status: 'STOPPED', message: null };
    if (up.length === expected.length) return { status: 'RUNNING', message: null };
    return { status: 'ERROR', message: `${restarted}, and ${up.join(', ')} is still running.` };
  }
  if (up.length === expected.length) return { status: 'RUNNING', message: null };
  const notUp = expected.filter((service) => !isUp(observedOf(service)));
  return {
    status: 'ERROR',
    message: `${restarted}, and ${notUp.map((service) => whatWasFound(service, observedOf(service))).join(', ')}.`,
  };
}

/** What a caller asks to run once the deploy it started has settled. */
export interface DeployHooks {
  /** After RUNNING is committed, which is when a watch on the result may begin. */
  afterRunning?: () => Promise<void>;
  /** After the script failed and the deployment was marked ERROR with the message. */
  afterFailure?: (message: string) => Promise<void>;
}

interface DeployFailureOwner {
  owner: ExpectedDeployOwner;
  referenceId: number | null;
}

const describeDeployOwner = ({ owner, referenceId }: DeployFailureOwner): string =>
  `instance ${owner.instanceId}, intent ${owner.intentRevision}, config ${owner.configRevision}, ` +
  `version ${owner.stackVersionId}, job reference ${referenceId ?? 'none'}`;

const describeDeployRow = (profile: Profile | null): string =>
  profile === null
    ? 'there is no such deployment any more'
    : `instance ${profile.instance_id}, intent ${profile.intent_revision}, config ${profile.engine_config_revision}, ` +
      `version ${profile.stack_version_id}, status ${profile.status}`;

interface JobConfig {
  profileName: string;
  target: string;
  reservedDaemonId?: string;
  deployFailure?: DeployFailureOwner;
  paths: StackPaths;
  script: string;
  args: string[];

  transitionTo?: ProfileStatus;

  allowedFrom?: readonly ProfileStatus[];

  /**
   * Addresses this job's own output must not carry whole.
   *
   * A Bee node prints its chain endpoint on every start, and again when it
   * cannot reach the chain, and the stack's assert-started.sh puts a failed
   * container's last lines on stderr. Those lines become the deployment's
   * `last_error`, an event every open page reads and a line in the manager's
   * own log, so a key in that URL's path would reach all four. The manager's
   * own endpoint is added to whatever a caller names here.
   */
  redactedEndpoints?: readonly (string | null | undefined)[];

  /** For a job that creates containers: the guard it holds while it runs. */
  guard?: { kind: DeployAttemptKind; services: readonly string[] };
  reservedAttempt?: DeployAttempt;

  beforeRun?: () => Promise<void>;

  /**
   * The last thing before the spawn, and the only place a launch is recorded.
   * A step that throws leaves nothing started.
   */
  beforeLaunch?: () => Promise<void>;

  onLaunch?: () => void;

  onSuccess: (attempt: DeployAttempt | null) => Promise<void>;
  /** Runs once the status claim is committed, before the script starts. */
  afterClaim?: () => Promise<void>;

  onFailure?: (message: string) => Promise<void>;
  markFailure?: (message: string) => Promise<void>;
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
  readonly attempt?: DeployAttempt;
  /**
   * The build the run will deploy from, captured with the claim. Null only
   * for a reservation made without one, which the run describes itself.
   */
  readonly build: BuildDescriptor | null;
}

type CapturedDeployReservation = DeployReservation & {
  readonly build: BuildDescriptor & { version: DeployVersionSnapshot };
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

/**
 * The values a deploy writes into the containers' environment that the profile
 * row does not carry, because a row is answered to every page and published on
 * every event. Each is read from its own column at the one moment it is
 * needed, and the deploy is the only thing here that holds them.
 */
interface DeploySecrets {
  streamKey: string | null;
  srtPassphrase: string | null;
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
    private readonly executions?: ExecutionRoots,
    /**
     * The manager's own chain endpoint, BEE_RPC_ENDPOINT. A deployment whose
     * source is `manager` has this written into its env file, and one whose
     * manager has since lost it fails its deploy rather than falling back to
     * the stack's public RPC without saying so.
     */
    private readonly managerRpcEndpoint?: string | null,
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
  private attemptKindOf(version: DeployVersionSnapshot | null): DeployAttemptKind {
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
   * service shows a new one and blocked otherwise. Never by time, and never
   * on the script, because the process that ran it is gone.
   */
  async reconcileAttempts(): Promise<{ released: string[]; blocked: string[] }> {
    const outcome = { released: [] as string[], blocked: [] as string[] };
    for (const attempt of await this.attempts.listUnresolved()) {
      if (attempt.state !== 'open') continue;
      // The manager that ran the script is gone, so nothing is known about how
      // it ended and only a new container can account for a service.
      const judged = await this.judgeAttempt(attempt, false);
      if (!judged) continue;
      (judged.state === 'released' ? outcome.released : outcome.blocked).push(attempt.project);
    }
    if (outcome.blocked.length > 0) {
      logger.warn(`[Orchestrator] deploy attempts left blocked at boot: ${outcome.blocked.join(', ')}`);
    }
    return outcome;
  }

  /**
   * What boot does with the rows a gone manager left in DEPLOYING, STOPPING
   * or REMOVING: each is judged by the containers its services have now and
   * written to what that says, so a restart inside a deploy that compose
   * finished no longer reports a streaming deployment as failed.
   *
   * Answers the rows it settled, newest status included, for boot to log.
   */
  async reconcileOrphanedTransitions(): Promise<Profile[]> {
    const settled: Profile[] = [];
    for (const orphan of await this.profiles.orphanedTransitions()) {
      const recovery = orphanRecoveryOf(orphan, defaultServicesFor(orphan), await this.projectContainers(orphan));
      const updated = await this.profiles.settleOrphanedTransition(orphan.name, recovery.status, recovery.message);
      if (!updated) continue;
      await this.publishChanged(updated);
      settled.push(updated);
    }
    return settled;
  }

  /** The project's containers by service, or null when the daemon did not answer for it. */
  private async projectContainers(profile: Profile): Promise<Map<string, ObservedContainer[]> | null> {
    const target = targetAlias(profile.host);
    try {
      const daemonId = await this.targetDaemon(target);
      const snapshot = await this.daemon.snapshot(profile.name, target);
      if (snapshot.daemonId !== daemonId) {
        throw new TargetNotVerifiedError(target, 'The container snapshot came from a different Docker daemon');
      }
      return snapshot.containers;
    } catch (err) {
      logger.warn(
        `[Orchestrator] the containers of ${profile.name} could not be read: ${getErrorMessage(err)}`,
      );
      return null;
    }
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

  private deployVersionOrThrow<T extends DeployVersionSnapshot>(profile: Profile, version: T | null): T {
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
   * The tree this deployment's scripts run in right now: its own copy of the
   * build once a deploy has made one, and the version's tree when it has none.
   *
   * Stop, health and remove have to agree with the deploy about this. The
   * compose files, the scripts and the deployment's own env file are all in
   * the copy, so a stop run from the version's tree would be stopping from a
   * checkout that never started anything. A deployment made before copies
   * existed, or one on a version that keeps no immutable builds, has none and
   * runs where it always did.
   */
  private async currentPathsFor(profile: Profile): Promise<StackPaths> {
    const root = await this.executions?.currentRootFor({ name: profile.name, instanceId: profile.instance_id });
    return root ? stackPathsForRoot(root) : this.pathsFor(profile);
  }

  /**
   * The secrets this version's containers refuse to start without, generated
   * the first time the deployment runs on it and kept from then on.
   *
   * Generated at deploy rather than at creation, so a version whose contract
   * grows a secret on Update is covered by the next deploy of every deployment
   * on it, with nothing to migrate.
   *
   * A key the version's own settings answer is neither generated nor written,
   * so the version's line stands. A value already stored against this
   * deployment still wins over both, because the containers were started with
   * it and rotating a token is a decision rather than a side effect.
   */
  private async stackSecretsFor(
    profile: Profile,
    version: DeployVersionSnapshot | null,
    root: string,
    engine: EngineName,
  ): Promise<StackSecrets> {
    const required = version?.contract?.requiredSecrets ?? [];
    if (required.length === 0) return {};

    const stored = await this.profiles.stackSecretsOf(profile.name);
    const supplied = versionSuppliedSecrets(root, engine, required);
    const generated = missingStackSecrets(
      required.filter((key) => !supplied.has(key)),
      stored,
    );
    if (Object.keys(generated).length > 0) {
      await this.profiles.storeStackSecrets(profile.name, generated);
      logger.info(
        `[Orchestrator] ${profile.name}: generated ${Object.keys(generated).join(', ')} for ${version?.name}`,
      );
    }

    const secrets: StackSecrets = {};
    for (const key of required) {
      const value = generated[key] ?? stored[key];
      if (value) secrets[key] = value;
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
    version: DeployVersionSnapshot | null,
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

  async captureRolloutSnapshot(profile: Profile, admission: RolloutAdmissionProof): Promise<PreparedRolloutDeploy['snapshot']> {
    const target = targetAlias(profile.host);
    const daemonId = await this.targetDaemon(target);
    if (admission.alias !== target || admission.daemonId !== daemonId) {
      throw new TargetNotVerifiedError(target, 'The prepared rollout belongs to a different Docker daemon. No deploy was started.');
    }
    const snapshot = await this.daemon.snapshot(profile.name, target);
    if (snapshot.daemonId !== daemonId) {
      throw new TargetNotVerifiedError(target, 'The container snapshot came from a different Docker daemon. No deploy was started.');
    }
    return { daemonId, containerIds: allContainerIds(snapshot.containers) };
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
    capturedVersion?: StackVersionRecord,
  ): Promise<DeployReservation> {
    return this.claim(profile, requested, 'advance', capturedVersion);
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
  private async operatorActed(profile: Profile, reason: string): Promise<Profile> {
    const updated = await this.profiles.bumpIntent(profile.name, profile.instance_id);
    if (!updated) throw new ProfileInstanceChangedError(profile.name);
    await this.operations.supersedeOpen(updated.instance_id, reason);
    return updated;
  }

  private async claim(
    profile: Profile,
    requested: string[] | undefined,
    intent: DeployClaimOwnership['intent'],
    capturedVersion?: StackVersionRecord,
  ): Promise<DeployReservation> {
    const version = capturedVersion === undefined
      ? structuredClone(await this.versionForDeploy(profile))
      : structuredClone(capturedVersion);
    const planned = this.planDeploy(profile, requested);

    await this.assertUploaderCanStart(profile, planned.services);
    await this.assertAttemptAdmissible(profile, this.attemptKindOf(version));

    // What the deploy will run is decided here, once. A version whose build
    // is missing is refused before anything is claimed, naming the build,
    // and never falls back to another root.
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
      if (!current) throw new ProfileNotFoundError(profile.name);
      if (current.instance_id !== profile.instance_id) throw new ProfileInstanceChangedError(profile.name);
      throw new ProfileBusyError(profile.name, current.status);
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
   * A failure marks ERROR only while the captured claim still owns the row.
   */
  async runReserved(
    reservation: DeployReservation,
    profile: Profile,
    hooks: DeployHooks = {},
  ): Promise<RunHandle> {
    let prepared = reservation;
    let failure: DeployFailureOwner = {
      owner: deployOwnerOf(reservation.claimedProfile ?? profile),
      referenceId: reservation.build?.referenceId ?? null,
    };
    try {
      const build = reservation.build ?? await this.ledger.describe(
        profile.name, await this.versionForDeploy(profile), [...reservation.services], failure.owner,
      );
      failure = { ...failure, referenceId: build.referenceId };
      const version = this.deployVersionOrThrow(profile, build.version);
      const captured: CapturedDeployReservation = { ...reservation,
        claimedProfile: reservation.claimedProfile ?? (reservation.build === null ? profile : undefined),
        build: { ...build, version } };
      prepared = captured;
      return await this.startReservedJob(captured, profile, hooks, failure);
    } catch (err) {
      // The guard is taken under the daemon's lock when the job starts, and
      // a deploy that passed the check a moment earlier can lose it there.
      // That is a refusal, not a failure: a claimed deployment gets its
      // status back. One that exists for this deploy alone has no status to
      // go back to and is marked failed with the reason, like any failure.
      // A config rollout committed its attempt with its file. Cancelling only
      // its job would discard the owner needed to recover that file.
      if (err instanceof DeployAttemptRefusedError && prepared.transitioned && !prepared.attempt) {
        await this.cancelReservation(prepared);
        throw err;
      }
      await this.markFailed(prepared.profileName, getErrorMessage(err), failure);
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
    const capturedProfile = structuredClone(profile);
    const owner = deployOwnerOf(capturedProfile);
    let reservation: DeployReservation;
    try {
      const planned = this.planDeploy(capturedProfile, requested, opts.host);
      const version = await this.versionForDeploy(capturedProfile);
      const problem = deployRootProblem(version);
      if (problem) throw new ProfileConfigError(capturedProfile.name, problem);
      const build = await this.ledger.describe(capturedProfile.name, version, planned.services, owner);
      reservation = { ...planned, claimedProfile: capturedProfile, build };
    } catch (err) {
      await this.markFailed(capturedProfile.name, getErrorMessage(err), { owner, referenceId: null });
      throw err;
    }
    return this.runReserved(reservation, capturedProfile);
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

  /**
   * The failure write of a deploy, and what happens when the row has moved.
   *
   * The owned write names every column the claim captured, so a config file
   * rollout or an intent change under the running script makes it match
   * nothing at all. The row is then still in DEPLOYING with no other write
   * coming for it, which refuses every later action on the deployment as
   * busy, so what did not match is logged and the failure is written on the
   * status, the claim's instance and its job reference. A row whose instance
   * or job has moved belongs to another claim, an admitted replacement or the
   * admitted job a refused duplicate lost to, and that claim's own outcome ends
   * it: nothing is written and that is said.
   */
  private async markDeployFailed(
    profileName: string,
    failure: DeployFailureOwner,
    message: string,
  ): Promise<Profile | null> {
    const owned = await this.profiles.markDeployError(profileName, failure.owner, failure.referenceId, message);
    if (owned) return owned;
    const row = await this.profiles.findByName(profileName);
    const mismatch = `it expected ${describeDeployOwner(failure)}, and the row says ${describeDeployRow(row)}.`;
    const ended = await this.profiles.markDeployingError(profileName, failure.owner.instanceId, failure.referenceId, message);
    if (ended) {
      logger.warn(
        `[Orchestrator] the failure of ${profileName} was not written by the deploy that owned it: ${mismatch} ` +
        'Written on the status and the instance instead, so the deployment does not stay in DEPLOYING.',
      );
      return ended;
    }
    logger.warn(
      `[Orchestrator] the failure of ${profileName} was not written: ${mismatch} ` +
      'Another claim owns the row now and its own outcome ends it.',
    );
    return null;
  }

  private async markFailed(
    profileName: string,
    message: string,
    deployFailure?: DeployFailureOwner,
  ): Promise<boolean> {
    try {
      const errored = deployFailure
        ? await this.markDeployFailed(profileName, deployFailure, message)
        : await this.profiles.markError(profileName, message);
      if (errored) {
        await this.publishChanged(errored);
      }
      return errored !== null;
    } catch (err) {
      logger.error(
        `[Orchestrator] failed to mark ${profileName} ERROR: ${getErrorMessage(err)}`,
      );
      return false;
    }
  }

  /**
   * A copy whose deploy never spawned anything. A tree left behind is a
   * nuisance and a failed removal is not a second failure, so this says so and
   * lets the boot sweep have another go.
   */
  private async retireQuietly(execution: PreparedExecution): Promise<void> {
    try {
      await this.executions?.retireUnstarted(execution.executionId);
    } catch (err) {
      logger.warn(`[Orchestrator] execution copy ${execution.executionId} was not removed: ${getErrorMessage(err)}`);
    }
  }

  private async startReservedJob(
    reservation: CapturedDeployReservation,
    profile: Profile,
    hooks: DeployHooks,
    failure: DeployFailureOwner,
  ): Promise<RunHandle> {
    let launchPossible = false;
    try {
      return await this.prepareReservedJob(reservation, profile, () => { launchPossible = true; }, hooks, failure);
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
    failure: DeployFailureOwner,
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

    // An empty service filter would make deploy.sh deploy every configured service.
    if (reservation.services.length === 0) {
      // Everything this deploy was for is waiting on a stamp, so the operator
      // hears why nothing ran rather than watching a deploy report success.
      if (reservation.heldBackForStamp.length > 0) throw new StampRequiredError(profile.name);
      return this.completeWithoutScript(reservation, profile, stackPathsForRoot(build.root), build.referenceId);
    }

    // Everything after this writes into the tree it names: the bootstrapped
    // defaults, this deployment's own env file, and the per-deployment files
    // the stack's scripts add. They go into a copy of the build rather than
    // into the build, which is what keeps an artifact the bytes it was
    // published as and keeps two deployments of one build out of each other's
    // files.
    const owner = reservation.claimedProfile ?? profile;
    const execution = build.referenceId === null ? null : await this.executions?.prepare({
      // DEPLOYING, and not the status this profile object carries: the claim
      // put the row there, and a caller may hold the row as it was before.
      profile: { name: owner.name, instanceId: owner.instance_id, intentRevision: owner.intent_revision, status: REDEPLOY_STATUS },
      build: { versionId: version.id, buildId: build.buildId, root: build.root, layout: version.layout },
      jobReferenceId: build.referenceId,
      target: { alias: targetAlias(reservation.host ?? profile.host), daemonId },
      services: reservation.services,
    }) ?? null;
    const paths = stackPathsForRoot(execution?.root ?? build.root);
    try {
      await this.ensureStackDefaults(paths);

      // .env.<profile> carries the per-profile keys deploy.sh reads from its env
      // file: ENGINE selects the uploader's engine plugin (and OME ports when
      // engine=ome), and a non-empty STAMP skips the interactive stamp prompt.
      const engine = engineForComponents(profile.components);
      const engineConfigFile = await this.engineConfigFileFor(profile, engine, version);
      // Read here and nowhere else: neither is a column of the row, so that no
      // page and no event carries them. This is where each becomes a line in a
      // file the containers read.
      const secrets: DeploySecrets = {
        streamKey: await this.profiles.privateKeyOf(profile.name),
        srtPassphrase: await this.profiles.srtPassphraseOf(profile.name),
      };
      const written = writeProfileEnv(paths.root, profile.name, {
        engine,
        stampId: profile.stamp_id,
        beePublishers: profile.bee_publishers,
        beeUrl: profile.bee_url,
        rpcEndpoint: profile.rpc_endpoint,
        rpcEndpointSource: profile.rpc_endpoint_source,
        managerRpcEndpoint: this.managerRpcEndpoint ?? null,
        // From the profile's own components and its stored mode, as
        // localBeeUploader is: this is the one place a mode becomes keys in a
        // file.
        gatewayMode: gatewayNodeMode(profile),
        srtPassphrase: secrets.srtPassphrase,
        streamKey: secrets.streamKey,
        engineSettings: profile.engine_settings,
        stackSecrets: await this.stackSecretsFor(profile, version, paths.root, engine),
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
        return await this.runJob({
        profileName: profile.name,
        target: targetAlias(reservation.host ?? profile.host),
        reservedDaemonId: daemonId,
        deployFailure: failure,
        onLaunch,
        paths,
        script: paths.deploy,
        args: this.buildDeployScriptArgs(profile, services, reservation.host),
        redactedEndpoints: [profile.rpc_endpoint],
        guard: { kind: this.attemptKindOf(version), services },
        reservedAttempt: reservation.attempt,
        beforeLaunch: execution && this.executions
          ? async () => {
            await this.executions!.claimLaunch(execution.executionId);
            await this.executions!.retireSuperseded(profile.name, { keep: 2 });
          }
          : undefined,
        onSuccess: async (attempt) => {
          await this.snapshotContainers(profile, paths, version, services, engineConfigFile, secrets);
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
          // The deploy is over, so the copy it replaced has done its job. D11
          // keeps one previous copy until a deploy comes up, and this is that.
          await this.executions?.retireSuperseded(profile.name, { keep: 1 });
          await runHook('after it came up', () => hooks.afterRunning?.());
        },
        onFailure: hooks.afterFailure
          ? (message) => runHook('after it failed', () => hooks.afterFailure?.(message))
          : undefined,
      });
    } catch (err) {
      // A copy nothing ran from goes with the job it was made for.
      // `retireUnstarted` matches only a copy still waiting to launch, so one
      // the job may already have spawned under is left exactly as it is.
      if (execution) await this.retireQuietly(execution);
      throw err;
    }
  }

  /**
   * A deploy of nothing: the checkout is made ready, the claim is given back,
   * and the deployment goes back to the status the claim took it from.
   *
   * Deliberately not RUNNING. Nothing was started, so nothing here has seen a
   * container, and a custom deployment with no components was marked RUNNING
   * over a project that has never had one. A deployment whose row was inserted
   * for this deploy has no earlier status to go back to and lands STOPPED,
   * which is what a deployment nothing has started is.
   */
  private async completeWithoutScript(
    reservation: DeployReservation,
    profile: Profile,
    paths: StackPaths,
    referenceId: number | null,
  ): Promise<RunHandle> {
    await this.ensureStackDefaults(paths);
    if (referenceId !== null) {
      await this.ledger.cancelUnstarted(profile.name, referenceId);
    }

    const restored = REDEPLOYABLE_FROM.includes(reservation.previousStatus)
      ? reservation.previousStatus
      : 'STOPPED';
    // A row going back to ERROR keeps a reason, and the reason it had was
    // cleared by the claim, so this one says what this deploy did instead.
    const updated = restored === 'ERROR'
      ? await this.profiles.markError(profile.name, NOTHING_TO_DEPLOY)
      : await this.profiles.markTerminal(profile.name, restored);
    if (updated) {
      await this.publishChanged(updated);
    }
    const emitter = new EventEmitter();
    setImmediate(() => emitter.emit('done', { code: 0, signal: null } satisfies RunOutcome));
    return { emitter, kill: () => undefined };
  }

  async startStop(
    profile: Profile,
    services: string[] | undefined,
  ): Promise<RunHandle> {
    const paths = await this.currentPathsFor(profile);
    return this.runJob({
      profileName: profile.name,
      target: targetAlias(profile.host),
      paths,
      script: paths.stop,
      args: this.buildScriptArgs(profile, services ?? []),
      transitionTo: 'STOPPING',
      allowedFrom: ['RUNNING', 'ERROR'],
      afterClaim: async () => {
        await this.operatorActed(
          profile,
          'Stopped by the operator before the file was verified.',
        );
      },
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
    input: { all?: boolean; expectedInstanceId?: string } = {},
  ): Promise<RunHandle & { profile: Profile }> {
    await this.assertRemovalReady(profile.name);
    await this.targetDaemon(targetAlias(profile.host));
    const expectedInstanceId = input.expectedInstanceId ?? profile.instance_id;
    const claimed = await this.profiles.claimRemoval(profile.name, expectedInstanceId);
    if (!claimed) {
      const current = await this.profiles.findByName(profile.name);
      if (!current || current.instance_id !== expectedInstanceId) throw new ProfileInstanceChangedError(profile.name);
      throw new ProfileBusyError(profile.name, current.status);
    }
    const markFailure = async (message: string) => {
      const errored = await this.profiles.failRemoval(claimed, message);
      if (errored) await this.publishChanged(errored);
    };
    try {
      await this.publishChanged(claimed);
      await this.operations.supersedeOpen(claimed.instance_id, 'The deployment was removed.');
      const paths = await this.currentPathsFor(claimed);
      const args = [`--profile=${claimed.name}`, `--host=${targetAlias(claimed.host)}`, `--portSlot=${claimed.port_slot}`, '--yes', '--volumes'];
      if (input.all) args.push('--all');
      const handle = await this.runJob({
        profileName: claimed.name,
        target: targetAlias(claimed.host),
        paths,
        script: paths.clean,
        args,
        beforeRun: () => this.assertRemovalReady(claimed.name),
        markFailure,
        onSuccess: async () => {
          await this.verifyPortRemoval(claimed);
          const removed = await this.profiles.completeRemoval(claimed, async () => {
            await this.removeProfileDataDir(claimed.name);
            deleteProfileEnv(paths.root, claimed.name);
          });
          if (!removed) return;
          // Nothing runs from them any more and no profile row claims them.
          await this.executions?.retireSuperseded(claimed.name, { keep: 0 });
          this.eventBus.publish({ type: 'profile.deleted', name: claimed.name });
          logger.info(`[Orchestrator] Removed profile ${claimed.name} (released slot ${removed.port_slot})`);
          await this.cleanupGroup(claimed.group_id);
        },
      });
      return { ...handle, profile: claimed };
    } catch (err) {
      await markFailure(getErrorMessage(err));
      throw err;
    }
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
    const paths = await this.currentPathsFor(profile);
    await this.ensureStackDefaults(paths);
    return this.runner.run(paths.health, this.buildScriptArgs(profile, []), {
      cwd: paths.root,
      env: beeDataDirsFor(profile.name, targetAlias(profile.host)),
    });
  }

  // rsync --delete on deploy wipes these gitignored files, so recreate before every script run.
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
    let attempt = cfg.reservedAttempt
      ? await this.validatedReservedAttempt(cfg, daemonId)
      : null;
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
      if (cfg.transitionTo) await this.markFailed(cfg.profileName, getErrorMessage(err), cfg.deployFailure);
      throw err;
    }

    // The guard, before anything is spawned: the project's containers as they
    // are, so what the attempt creates can be told from what was there.
    if (cfg.guard && !attempt) {
      const snapshotToken = await this.attempts.captureSnapshotToken(daemonId, cfg.profileName);
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
        preJobContainerIds: allContainerIds(before.containers),
        snapshotToken,
      });
      this.eventBus.publish({ type: 'attempt.changed' });
    }

    logger.info(
      `[Orchestrator] ${cfg.profileName} running: bash ${cfg.script} ${describeArgsForLog(cfg.args)}`,
    );

    await cfg.beforeLaunch?.();
    cfg.onLaunch?.();
    const handle = this.runner.run(cfg.script, cfg.args, {
      cwd: cfg.paths.root,
      env: beeDataDirsFor(cfg.profileName, cfg.target),
    });

    let stderrTail = '';
    let stdoutTail = '';
    handle.emitter.on('stderr', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    handle.emitter.on('stdout', (chunk: string) => {
      stdoutTail = (stdoutTail + chunk).slice(-STDOUT_TAIL_BYTES);
    });

    // Before failureReason is built out of them, so the stored reason, the
    // event and the log line are all the redacted text rather than three
    // chances to leak the same URL.
    const endpoints = [this.managerRpcEndpoint, ...(cfg.redactedEndpoints ?? [])];
    let finalizationStarted = false;
    const finish = (outcome: RunOutcome, errorText: string) => {
      if (finalizationStarted) return;
      finalizationStarted = true;
      void (async () => {
        if (attempt) await this.judgeAttempt(attempt, outcome.code === 0);
        await this.finalizeJob(
          cfg,
          {
            ...outcome,
            stderrTail: redactEndpoints(errorText, endpoints),
            stdoutTail: redactEndpoints(stdoutTail, endpoints),
          },
          attempt,
        );
      })();
    };
    handle.emitter.on('done', (outcome: RunOutcome) => finish(outcome, stderrTail));
    // A script that never started ends the attempt the same way: nothing new
    // was created, so it blocks, and the host is not held open for nothing.
    handle.emitter.on('error', (err: Error) => finish({ code: -1, signal: null }, err.message));

    return handle;
  }

  private async validatedReservedAttempt(cfg: JobConfig, daemonId: string): Promise<DeployAttempt> {
    const expected = cfg.reservedAttempt!;
    const current = await this.attempts.findByJob(expected.jobId);
    if (!cfg.guard || expected.state !== 'open' || expected.daemonId !== daemonId ||
        expected.target !== cfg.target || expected.project !== cfg.profileName ||
        expected.kind !== cfg.guard.kind || !isDeepStrictEqual(expected.services, cfg.guard.services) ||
        !isDeepStrictEqual(current, expected)) {
      throw new DeployAttemptRefusedError(cfg.profileName, 'The prepared deploy attempt changed or no longer owns this deployment. No deploy was started.');
    }
    return current!;
  }

  /**
   * The attempt is judged by its project's containers the moment the script
   * ends, whatever the exit code: released when every touched service shows
   * a new container, blocked naming the rest. A daemon that does not answer
   * leaves it open for boot to judge.
   */
  private async judgeAttempt(attempt: DeployAttempt, scriptFinished: boolean): Promise<AttemptOutcome | null> {
    try {
      const profile = attempt.target ? null : await this.profiles.findByName(attempt.project);
      if (!attempt.target && !profile) throw new Error('The legacy attempt has no recorded target or deployment');
      const target = targetAlias(attempt.target ?? profile!.host);
      const snapshot = await this.daemon.snapshot(attempt.project, target);
      if (snapshot.daemonId !== attempt.daemonId) {
        throw new TargetNotVerifiedError(target, 'The attempt target now reaches a different Docker daemon');
      }
      const judged: AttemptOutcome = attemptOutcome(attempt, containerIdsByService(snapshot.containers), scriptFinished);
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
    outcome: JobOutcome,
    attempt: DeployAttempt | null,
  ): Promise<void> {
    try {
      if (outcome.code === 0) {
        await cfg.onSuccess(attempt);
        logger.info(`[Orchestrator] ${cfg.profileName} ← success`);
        return;
      }
      const message = failureReason(cfg.script, outcome);
      if (cfg.markFailure) {
        await cfg.markFailure(message);
        await cfg.onFailure?.(message);
      } else if (await this.markFailed(cfg.profileName, message, cfg.deployFailure)) {
        await cfg.onFailure?.(message);
      }
      logger.warn(
        `[Orchestrator] ${cfg.profileName} ← ERROR (code=${outcome.code})\n${message}`,
      );
    } catch (err) {
      const message = getErrorMessage(err);
      logger.error(
        `[Orchestrator] failed to finalize ${cfg.profileName}: ${message}`,
      );
      if (cfg.markFailure) {
        try { await cfg.markFailure(message); }
        catch (failure) { logger.error(`[Orchestrator] failed to record owned removal failure: ${getErrorMessage(failure)}`); }
      } else await this.markFailed(cfg.profileName, message, cfg.deployFailure);
    }
  }

  /** Which deployment, on which slot and host, and which services this run is for. */
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
    args.push(...services);
    return args;
  }

  /**
   * The same, plus the three overrides only deploy.sh reads.
   *
   * The stack checks the shape of every flag it is handed, on every script, in
   * _lib.sh's parse_profile_args. Handing these to stop.sh and health.sh made a
   * stored value the stack refuses fail those too, and a deployment that cannot
   * be stopped is the worst shape there is.
   */
  private buildDeployScriptArgs(
    profile: Profile,
    services: string[],
    hostOverride?: string,
  ): string[] {
    const overrides: string[] = [];
    if (profile.feed_owner) overrides.push(`--feed-owner=${profile.feed_owner}`);
    if (profile.feed_topic) overrides.push(`--feed-topic=${profile.feed_topic}`);
    if (profile.stamp_id) overrides.push(`--stamp-id=${profile.stamp_id}`);
    return [
      ...this.buildScriptArgs(profile, [], hostOverride),
      ...overrides,
      ...services,
    ];
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
    version: DeployVersionSnapshot | null,
    services: string[],
    engineConfigFile: string | null,
    secrets: DeploySecrets,
  ): Promise<void> {
    try {
      const env = this.buildEffectiveEnv(profile, paths, version, secrets);
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
   * it, and the per profile values `.env.<profile>` carries, except the chain
   * endpoint and the gateway's mode keys, which are not repeated here.
   */
  private buildEffectiveEnv(
    profile: Profile,
    paths: StackPaths,
    version: DeployVersionSnapshot | null,
    secrets: DeploySecrets,
  ): Record<string, string> {
    const env = parseBaseEnv(paths.root);

    Object.assign(env, beeDataDirsFor(profile.name, targetAlias(profile.host)));

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

    // Parameter overrides, same mapping as deploy/scripts/_lib.sh::parameter_overrides_text.
    if (profile.feed_owner) {
      env.VITE_APP_OWNER = profile.feed_owner.replace(/^0x/, '');
    }
    if (profile.feed_topic) {
      env.STREAM_LIST_TOPIC = profile.feed_topic;
      env.VITE_APP_RAW_TOPIC = profile.feed_topic;
    }
    if (secrets.streamKey) {
      env.STREAM_KEY = secrets.streamKey;
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
    if (secrets.srtPassphrase) {
      env.SRT_PASSPHRASE = secrets.srtPassphrase;
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
