import { setTimeout as sleep } from 'node:timers/promises';

import {
  defaultServicesFor,
  ENGINE_CONFIG_MAX_BYTES,
  ENGINE_CONFIG_REFERENCES,
  ENGINE_DISPLAY_NAMES,
  type EngineConfigView,
  type EngineName,
  engineOfServices,
  getErrorMessage,
  OME_SERVICE,
} from '@streaming-infra-manager/common';

import {
  Profile,
  ProfileStatus,
  ProfileWithContainers,
  TRANSITIONAL_STATUSES,
} from '../../types/index.js';
import { ContainerRepository } from '../ContainerRepository.js';
import type { ContainerState } from '../ContainerControl.js';
import { engineConfigDirFor } from '../dataDirs.js';
import {
  DeploymentOrchestrator,
  type DeployReservation,
} from '../DeploymentOrchestrator.js';
import {
  ProfileBusyError,
  ProfileConfigError,
  ProfileNotFoundError,
} from '../errors/index.js';
import { EventBus } from '../EventBus.js';
import { Logger } from '../Logger.js';
import { ProfileRepository } from '../ProfileRepository.js';
import { omePortsFor, portTableOf } from '../versions/portTable.js';
import type {
  StackVersionRecord,
  StackVersionRepository,
} from '../versions/StackVersionRepository.js';
import { deployRootProblem, stackRootOf } from '../versions/stackPaths.js';

import { EngineConfigChecker } from './engineConfigCheck.js';
import type { EngineConfigOperationRepository } from './EngineConfigOperationRepository.js';
import type { ClaimedRolloutDeploy } from './rolloutDeployAdmission.js';
import { engineTemplateIn } from './engineConfigTemplates.js';
import {
  type EngineConfigOperation,
  type EngineConfigOperationKind,
  type EngineConfigOperationState,
  ownershipOf,
} from './operations.js';

const logger = Logger.getInstance();

/** How the engine is watched after it was recreated on a new file. */
export interface EngineWatchTiming {
  intervalMs: number;
  durationMs: number;
  /** How long the HLS port is tried for after the watch, for an engine with no parser to ask. */
  probeBudgetMs: number;
}

/**
 * Twenty seconds, which covers a config the engine parses and then dies on a
 * few seconds in, and is short enough that an operator who is watching sees
 * the revert happen rather than finding it later. The port is tried for ten
 * more, which covers an engine that binds late.
 */
export const DEFAULT_ENGINE_WATCH: EngineWatchTiming = {
  intervalMs: 2_000,
  durationMs: 20_000,
  probeBudgetMs: 10_000,
};

/** How much of the engine's log a revert reads, and how much of it is kept. */
const LOG_TAIL_LINES = 40;
const LOG_KEPT_LINES = 10;
const LOG_TAIL_BYTES = 4_096;

/**
 * The lines in a tail that say what went wrong. SRS prints its authors and
 * its build flags on every start, and the one line that names the missing
 * pid file sits under twenty of those.
 */
const LOG_REASON_RE = /error|fail|invalid|refus|cannot|denied|errno|no such|exit/i;

/** The slice of ContainerControl the watch, the revert and the probe after the watch use. */
export interface EngineWatcher {
  inspect(profile: string, service: string): Promise<ContainerState | null>;
  logs(profile: string, service: string, tail: number): Promise<string>;
  /** Whether a TCP connection to a published port opens within the budget. */
  reachable(port: number, budgetMs: number): Promise<boolean>;
}

/**
 * A config file of the deployment's own for its media engine: reading what
 * the editor opens on, applying a file after the engine's own parser has
 * accepted it, and putting the previous file back when the engine will not
 * stay up on the new one.
 *
 * Applying recreates the engine container the way saving its settings does,
 * through the same claim on the deployment, and then watches the container
 * for a while. A file that parses can still stop the engine a few seconds in,
 * and a stream deployment left down over a typo is the worst outcome the
 * feature could have.
 */
export class EngineConfigService {
  constructor(
    private readonly profiles: ProfileRepository,
    private readonly containers: ContainerRepository,
    private readonly orchestrator: DeploymentOrchestrator,
    private readonly versions: StackVersionRepository,
    private readonly control: EngineWatcher,
    private readonly checker: EngineConfigChecker,
    private readonly events: EventBus,
    private readonly operations: EngineConfigOperationRepository,
    private readonly watch: EngineWatchTiming = DEFAULT_ENGINE_WATCH,
  ) {}

  async view(name: string): Promise<EngineConfigView> {
    const profile = await this.require(name);
    const engine = engineOf(profile);
    const version = await this.versions.findById(profile.stack_version_id);
    const template = engineTemplateIn(
      await this.orchestrator.stackRootFor(profile),
      engine,
    );
    const supported = supportsEngineConfig(version, engine);
    return {
      engine,
      supported,
      unsupportedReason: supported ? null : unsupportedReason(version, engine),
      config: await this.profiles.engineConfigOf(name),
      template: template.text,
      placeholders: template.placeholders,
      state: profile.engine_config_state,
      error: profile.engine_config_error,
      references: ENGINE_CONFIG_REFERENCES[engine],
    };
  }

  /**
   * Checks the file, stores it, recreates the engine on it and watches.
   *
   * Everything that can refuse runs before the claim is taken, so a refused
   * save changes nothing. The claim comes before the write, and the write
   * records who owns the rollout: the open operation of this deployment
   * instance, the config revision it produced and the intent it started
   * under. Every later step checks those together and does nothing once any
   * of them moved.
   */
  async apply(name: string, config: string): Promise<ProfileWithContainers> {
    const existing = await this.require(name);
    refuseWhileTransitional(existing);
    const engine = engineOf(existing);
    const version = await this.deployVersion(existing);
    if (!supportsEngineConfig(version, engine)) {
      throw new ProfileConfigError(name, unsupportedReason(version, engine));
    }
    refuseBySize(name, config);

    const root = stackRootOf(version);
    const template = engineTemplateIn(root, engine);
    const problem = await this.checker.problem({
      engine,
      config,
      image: version?.contract?.engineImages[engine] ?? null,
      filled: template.placeholders,
      template: template.text,
      scratchDir: engineConfigDirFor(name),
    });
    if (problem) throw new ProfileConfigError(name, problem);

    return this.rollOut(existing, engine, 'apply', config, version);
  }

  /**
   * Back to the version's template, which needs no check and no watch. A
   * deployment already on the template with no rollout open has nothing to
   * recreate.
   */
  async reset(name: string): Promise<ProfileWithContainers> {
    const existing = await this.require(name);
    refuseWhileTransitional(existing);
    const engine = engineOf(existing);
    const open = await this.operations.findOpen(existing.instance_id);
    if (!existing.has_engine_config && !open) {
      return this.containers.withContainers(existing);
    }
    return this.rollOut(existing, engine, 'reset', null, await this.deployVersion(existing));
  }

  /**
   * Recreates the engine on what is stored, file or template, and verifies
   * it: a rollout of its own, which supersedes an interrupted one before it
   * stores, so no operation is left open behind it.
   */
  async verifyNow(name: string): Promise<ProfileWithContainers> {
    const existing = await this.require(name);
    refuseWhileTransitional(existing);
    const engine = engineOf(existing);
    return this.rollOutStored(existing, engine, await this.profiles.engineConfigOf(name));
  }

  /** Puts the file an interrupted rollout recorded as previous back, as a rollout of its own. */
  async recreateOnPrevious(name: string): Promise<ProfileWithContainers> {
    const existing = await this.require(name);
    refuseWhileTransitional(existing);
    const engine = engineOf(existing);
    const open = await this.operations.findOpen(existing.instance_id);
    if (!open || open.state !== 'interrupted') {
      throw new ProfileConfigError(name, 'There is no interrupted rollout to go back from.');
    }
    const begun = await this.operations.beginRestorePreviousDeploy({
      profile: existing, engine, ownership: ownershipOf(open),
      message: 'Restoring the previous config file at the operator\'s request.',
      ...await this.prepareAdmission(existing),
    });
    if (!begun) throw new ProfileConfigError(name, 'The interrupted rollout changed. Reload and try again.');
    await this.publish(begun.profile);
    await this.runRecovery(begun, 'reverted', 'The requested previous config file could not be recreated.', true);
    return this.containers.withContainers(begun.profile);
  }

  /**
   * What boot does with a rollout a gone manager left open. An outage is
   * never a pass: a healthy container the operation recorded is watched
   * again in full, failure evidence reverts through the owned path, and
   * anything the manager cannot tell becomes interrupted, with the actions
   * the card offers.
   */
  async reconcileAtBoot(): Promise<void> {
    for (const operation of await this.operations.listOpen()) {
      const ownership = ownershipOf(operation);
      const profile = await this.profiles.findByName(operation.profileName);
      if (!profile || profile.instance_id !== operation.profileInstanceId) {
        await this.operations.supersedeOpen(
          operation.profileInstanceId,
          'The deployment this rollout belonged to is gone.',
        );
        continue;
      }
      if (operation.state === 'applying') {
        await this.operations.transition(ownership, ['applying'], 'interrupted', {
          message: 'Apply interrupted by a manager restart. The file is stored, the engine was not verified.',
        });
        continue;
      }
      if (operation.state === 'reverting') {
        await this.operations.transition(ownership, ['reverting'], 'interrupted', {
          message: 'Recovery interrupted by a manager restart. The previous file is stored, the engine was not verified.',
        });
        continue;
      }
      if (operation.state !== 'watching') continue;
      if (profile.status !== 'RUNNING') {
        await this.operations.transition(ownership, ['watching'], 'superseded', {
          message: `The deployment was ${profile.status.toLowerCase()} when the manager came back, so the file was not verified.`,
        });
        continue;
      }

      let state: ContainerState | null;
      try {
        state = await this.control.inspect(operation.profileName, operation.engine);
      } catch {
        await this.operations.transition(ownership, ['watching'], 'interrupted', {
          message: 'Verification interrupted by a manager restart, and the engine could not be inspected.',
        });
        continue;
      }
      if (state && operation.containerId !== null && state.id !== operation.containerId) {
        await this.operations.transition(ownership, ['watching'], 'superseded', {
          message: 'The engine was recreated by something else while the manager was away.',
        });
        continue;
      }
      if (state && state.status === 'running' && state.restartCount === 0) {
        const fresh = await this.operations.transition(ownership, ['watching'], 'watching', {
          watchStartedAt: new Date(),
        });
        if (fresh) this.watchInBackground(fresh);
        continue;
      }
      await this.revertOwned(operation, 'RUNNING', state, 'reverted');
    }
  }

  // ---------------------------------------------------------- the rollout

  /** A rollout on what is stored: the file, or the template when there is none. */
  private async rollOutStored(
    existing: Profile,
    engine: EngineName,
    config: string | null,
  ): Promise<ProfileWithContainers> {
    return this.rollOut(existing, engine, config === null ? 'reset' : 'apply', config, await this.deployVersion(existing));
  }

  private async rollOut(
    existing: Profile,
    engine: EngineName,
    kind: Exclude<EngineConfigOperationKind, 'restore-previous'>,
    config: string | null,
    version: StackVersionRecord,
  ): Promise<ProfileWithContainers> {
    const started = await this.operations.beginDeploy({
      profile: existing, version, engine, kind, config, ...await this.prepareAdmission(existing),
    });
    if (!started) throw new ProfileConfigError(existing.name, 'The deployment or config file changed. Reload and try again.');

    logger.info(
      `[EngineConfig] ${existing.name}: ${config === null ? 'back to the template' : 'applying a config file'}, operation ${started.operation.id}, recreating ${engine}`,
    );
    await this.publish(started.profile);

    try {
      await this.orchestrator.runReserved(reservationOf(started), started.profile, {
        afterRunning: () => this.afterRecreate(started.operation),
        afterFailure: (message) =>
          this.revertOwned(started.operation, 'ERROR', null, 'failed', message),
      });
    } catch (err) {
      await this.interruptPreparation(started, getErrorMessage(err));
      throw err;
    }
    return this.containers.withContainers(started.profile);
  }

  /**
   * Runs once RUNNING is committed. A template needs no watch. A file is
   * watched from here, with the container the watch is about recorded, so a
   * manager restart can tell that container from a replacement.
   */
  private async afterRecreate(operation: EngineConfigOperation): Promise<void> {
    const ownership = ownershipOf(operation);
    if (operation.kind === 'reset') {
      await this.operations.transition(ownership, ['applying'], 'applied', {
        recreateFinishedAt: new Date(),
      });
      return;
    }
    const container = await this.control
      .inspect(operation.profileName, operation.engine)
      .catch(() => null);
    const watching = await this.operations.transition(ownership, ['applying'], 'watching', {
      containerId: container?.id ?? null,
      containerStartedAt: container?.startedAt ?? null,
      recreateFinishedAt: new Date(),
      watchStartedAt: new Date(),
    });
    if (watching) this.watchInBackground(watching);
  }

  /** The watch runs for its whole duration, and the success hook that started it must not wait on it. */
  private watchInBackground(operation: EngineConfigOperation): void {
    this.watchEngine(operation).catch((err: unknown) => {
      logger.error(
        `[EngineConfig] the watch on ${operation.profileName} failed: ${getErrorMessage(err)}`,
      );
    });
  }

  /**
   * Looks at the container every interval for the duration. Every tick
   * re-reads the rows first and ends the watch, without acting, when the
   * rollout no longer owns the deployment. A container that is not running,
   * has restarted, or is not the one the watch is about is what ends it with
   * a revert. Completion is conditional on ownership too, so a superseded
   * rollout cannot relabel itself applied from its last healthy tick.
   */
  private async watchEngine(operation: EngineConfigOperation): Promise<void> {
    try {
      await this.watchTicks(operation);
    } catch (err) {
      // A read or a write that failed mid watch. Left alone the row would say
      // watching with nothing watching it until the next restart.
      await this.operations.transition(ownershipOf(operation), ['watching'], 'interrupted', {
        message: `Verification interrupted: ${getErrorMessage(err)}`,
      });
    }
  }

  private async watchTicks(operation: EngineConfigOperation): Promise<void> {
    const ownership = ownershipOf(operation);
    const ticks = Math.max(1, Math.round(this.watch.durationMs / this.watch.intervalMs));
    for (let tick = 0; tick < ticks; tick += 1) {
      await sleep(this.watch.intervalMs);
      if (!(await this.owns(operation, ['watching'], 'RUNNING'))) return;
      let state: ContainerState | null;
      try {
        state = await this.control.inspect(operation.profileName, operation.engine);
      } catch (err) {
        await this.operations.transition(ownership, ['watching'], 'interrupted', {
          message: `The engine could not be inspected while the file was being verified: ${getErrorMessage(err)}`,
        });
        return;
      }
      const sameContainer = operation.containerId === null || state?.id === operation.containerId;
      if (state && state.status === 'running' && state.restartCount === 0 && sameContainer) continue;
      if (state && !sameContainer) {
        await this.operations.transition(ownership, ['watching'], 'superseded', {
          message: 'The engine was recreated by something else while the file was being verified.',
        });
        return;
      }
      await this.revertOwned(operation, 'RUNNING', state, 'reverted');
      return;
    }
    const note = await this.livenessNote(operation);
    const applied = await this.operations.transition(ownership, ['watching'], 'applied', {
      message: note,
    });
    if (applied) {
      logger.info(
        `[EngineConfig] ${operation.profileName}: ${operation.engine} stayed up on the new config file for ${this.watch.durationMs / 1000} s${note ? `, ${note}` : ''}`,
      );
    }
  }

  /**
   * What the port the engine publishes on says once the watch is over, for
   * an engine whose parser could not be asked before the recreate. A port
   * that answers is liveness, not a verdict on the file, and one that does
   * not is a note the card shows next to the applied rollout, never a reason
   * to put the previous file back: the engine is up, and the file may be
   * what it is meant to be.
   */
  private async livenessNote(operation: EngineConfigOperation): Promise<string | null> {
    if (operation.engine !== OME_SERVICE) return null;
    const profile = await this.profiles.findByName(operation.profileName);
    if (!profile) return null;
    const version = await this.versions.findById(profile.stack_version_id);
    const port = omePortsFor(profile.port_slot, portTableOf(version?.contract)).omeHlsPort;
    if (!port) return null;
    if (await this.control.reachable(port, this.watch.probeBudgetMs)) return null;
    return (
      `The HLS port ${port} did not answer from the manager within ${Math.round(this.watch.probeBudgetMs / 1000)} s after the watch. ` +
      `${ENGINE_DISPLAY_NAMES[operation.engine]} is running, so this is a diagnosis and not a verdict on the file: check its logs and the port.`
    );
  }

  /** Whether the rollout still owns the deployment: its state, the instance, both revisions, and the status when one is required. */
  private async owns(
    operation: EngineConfigOperation,
    states: readonly EngineConfigOperationState[],
    status: ProfileStatus | null = null,
  ): Promise<boolean> {
    const [current, profile] = await Promise.all([
      this.operations.findById(operation.id),
      this.profiles.findByName(operation.profileName),
    ]);
    return Boolean(
      current &&
        profile &&
        states.includes(current.state) &&
        profile.instance_id === operation.profileInstanceId &&
        profile.engine_config_revision === operation.appliedRevision &&
        profile.intent_revision === operation.intentRevision &&
        (status === null || profile.status === status),
    );
  }

  /**
   * The owned revert: ownership checked, the deploy claim taken, then one
   * conditional write that puts the previous file back and marks the
   * operation reverting, then the recreate. A refused claim keeps a still-owned
   * operation interrupted and leaves the file unchanged. Lost ownership changes
   * neither the operation nor the file. `from` is the status the deployment
   * must still be in, RUNNING for a watch and ERROR for a recreate that
   * failed, so a stopped deployment is never recreated by either. `failure`
   * is the reason when the rollout's own recreate failed, and the operation
   * then ends failed rather than reverted, with both reasons kept.
   */
  private async revertOwned(
    operation: EngineConfigOperation,
    from: ProfileStatus,
    state: ContainerState | null,
    terminal: 'reverted' | 'failed',
    failure?: string,
  ): Promise<void> {
    if (!(await this.owns(operation, ['watching', 'applying'], from))) return;
    const profile = await this.profiles.findByName(operation.profileName);
    if (!profile) return;

    const tail = await this.control
      .logs(operation.profileName, operation.engine, LOG_TAIL_LINES)
      .catch(() => '');
    const message = failure
      ? `${ENGINE_DISPLAY_NAMES[operation.engine]} could not be recreated on the new config file (${failure}), so the previous one is back.`
      : revertMessage(operation.engine, state, tail);
    let begun: ClaimedRolloutDeploy | null;
    try {
      begun = await this.operations.beginRevertDeploy({
        profile, engine: operation.engine, ownership: ownershipOf(operation), message,
        ...await this.prepareAdmission(profile),
      });
    } catch (err) {
      const reason = failure
        ? `The original recreate failed: ${failure}`
        : `${ENGINE_DISPLAY_NAMES[operation.engine]} ${describeState(state)} on the new config file. ${reasonLines(tail)}`.trim();
      await this.operations.transition(ownershipOf(operation), ['watching', 'applying'], 'interrupted', {
        message: `Recovery interrupted before the previous config file was restored. ${reason}. The revert could not claim the deployment: ${getErrorMessage(err)}`,
      });
      return;
    }
    if (!begun) return;
    logger.warn(`[EngineConfig] ${operation.profileName}: ${message.split('\n')[0]}`);
    await this.publish(begun.profile);

    await this.runRecovery(begun, terminal, message);
  }

  private async runRecovery(begun: ClaimedRolloutDeploy, terminal: 'reverted' | 'failed', message: string, propagateError = false): Promise<void> {
    const reverting = ownershipOf(begun.operation);
    try {
      await this.orchestrator.runReserved(reservationOf(begun), begun.profile, {
        afterRunning: async () => {
          await this.operations.transition(reverting, ['reverting'], terminal, {
            recreateFinishedAt: new Date(),
          });
        },
        afterFailure: async (second) => {
          await this.operations.transition(reverting, ['reverting'], 'failed', {
            message: `${message} The recreate on it failed too: ${second}`,
          });
        },
      });
    } catch (err) {
      await this.interruptPreparation(begun, `${message} The previous file could not be recreated on: ${getErrorMessage(err)}`);
      if (propagateError) throw err;
    }
  }

  private async interruptPreparation(claimed: ClaimedRolloutDeploy, message: string): Promise<void> {
    const referenceId = claimed.descriptor.referenceId;
    if (referenceId === null) return;
    await this.operations.transition(ownershipOf(claimed.operation), ['applying', 'reverting'], 'interrupted', {
      message: `Deployment preparation interrupted: ${message}`,
    }, referenceId);
  }

  // ---------------------------------------------------------- the plumbing

  private async prepareAdmission(profile: Profile) {
    const admission = await this.operations.captureDeployAdmission(profile);
    return { admission, snapshot: await this.orchestrator.captureRolloutSnapshot(profile, admission) };
  }

  private async deployVersion(profile: Profile): Promise<StackVersionRecord> {
    const version = await this.versions.findById(profile.stack_version_id);
    if (!version) throw new ProfileConfigError(profile.name, `Stack version ${profile.stack_version_id} no longer exists.`);
    const problem = deployRootProblem(version);
    if (problem) throw new ProfileConfigError(profile.name, problem);
    return version;
  }

  private async require(name: string): Promise<Profile> {
    const profile = await this.profiles.findByName(name);
    if (!profile) throw new ProfileNotFoundError(name);
    return profile;
  }

  private async publish(row: Profile): Promise<void> {
    const profile = await this.containers.withContainers(row);
    this.events.publish({ type: 'profile.changed', profile });
  }
}

function reservationOf(claimed: ClaimedRolloutDeploy): DeployReservation {
  return {
    profileName: claimed.profile.name, claimedProfile: claimed.profile,
    services: claimed.attempt.services, heldBackForStamp: [],
    previousStatus: claimed.previousStatus, transitioned: true,
    host: claimed.attempt.target ?? claimed.profile.host ?? undefined, daemonId: claimed.attempt.daemonId,
    build: claimed.descriptor, attempt: claimed.attempt,
  };
}

// ------------------------------------------------------------ the rules

function engineOf(profile: Profile): EngineName {
  const engine = engineOfServices(defaultServicesFor(profile));
  if (!engine) {
    throw new ProfileConfigError(
      profile.name,
      `${profile.name} runs no media server, so it has no engine config. Only a stream or an ABR uploader has one.`,
    );
  }
  return engine;
}

function refuseWhileTransitional(profile: Profile): void {
  if ((TRANSITIONAL_STATUSES as readonly string[]).includes(profile.status)) {
    throw new ProfileBusyError(profile.name, profile.status);
  }
}

function supportsEngineConfig(
  version: StackVersionRecord | null,
  engine: EngineName,
): boolean {
  return version?.contract?.engineConfig[engine] ?? false;
}

function unsupportedReason(
  version: StackVersionRecord | null,
  engine: EngineName,
): string {
  const name = version?.name ?? 'This stack version';
  return (
    `${name} renders the ${ENGINE_DISPLAY_NAMES[engine]} config from its template and cannot run a file of its own. ` +
    'Deploy on main-v3 or a later version to edit it.'
  );
}

function refuseBySize(name: string, config: string): void {
  if (!config.trim()) {
    throw new ProfileConfigError(
      name,
      'The file is empty. Use Back to the template to run the template again.',
    );
  }
  const bytes = Buffer.byteLength(config, 'utf8');
  if (bytes > ENGINE_CONFIG_MAX_BYTES) {
    throw new ProfileConfigError(
      name,
      `The file is ${Math.ceil(bytes / 1024)} KiB, and the most the manager stores is ${ENGINE_CONFIG_MAX_BYTES / 1024} KiB.`,
    );
  }
}

function describeState(state: ContainerState | null): string {
  if (!state) return 'is not running';
  if (state.status === 'restarting') return 'keeps restarting';
  if (state.restartCount > 0) {
    return `restarted ${state.restartCount} ${state.restartCount === 1 ? 'time' : 'times'}`;
  }
  return `is ${state.status}`;
}

/** The reasons in a log tail, else its last lines, in the size a card can show. */
function reasonLines(tail: string): string {
  const lines = tail.split('\n').filter((line) => line.trim().length > 0);
  const reasons = lines.filter((line) => LOG_REASON_RE.test(line));
  const kept = (reasons.length > 0 ? reasons : lines).slice(-LOG_KEPT_LINES);
  return kept.join('\n').slice(-LOG_TAIL_BYTES);
}

function revertMessage(
  engine: EngineName,
  state: ContainerState | null,
  tail: string,
): string {
  const lines = reasonLines(tail);
  const head = `${ENGINE_DISPLAY_NAMES[engine]} ${describeState(state)} on the new config file, so the previous one is back.`;
  return lines ? `${head} The engine's last lines:\n${lines}` : head;
}
