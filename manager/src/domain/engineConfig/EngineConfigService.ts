import { setTimeout as sleep } from 'node:timers/promises';

import {
  defaultServicesFor,
  ENGINE_CONFIG_MAX_BYTES,
  ENGINE_CONFIG_REFERENCES,
  ENGINE_DISPLAY_NAMES,
  type EngineConfigView,
  type EngineName,
  engineOfServices,
} from '@streaming-infra-manager/common';

import { Profile, ProfileWithContainers, TRANSITIONAL_STATUSES } from '../../types/index.js';
import { ContainerRepository } from '../ContainerRepository.js';
import type { ContainerState } from '../ContainerControl.js';
import { engineConfigDirFor } from '../dataDirs.js';
import { DeploymentOrchestrator } from '../DeploymentOrchestrator.js';
import {
  ProfileBusyError,
  ProfileConfigError,
  ProfileNotFoundError,
} from '../errors/index.js';
import { EventBus } from '../EventBus.js';
import { Logger } from '../Logger.js';
import { ProfileRepository } from '../ProfileRepository.js';
import { RunHandle } from '../ScriptRunner.js';
import type {
  StackVersionRecord,
  StackVersionRepository,
} from '../versions/StackVersionRepository.js';

import { EngineConfigChecker } from './engineConfigCheck.js';
import { engineTemplateIn } from './engineConfigTemplates.js';

const logger = Logger.getInstance();

/** How the engine is watched after it was recreated on a new file. */
export interface EngineWatchTiming {
  intervalMs: number;
  durationMs: number;
}

/**
 * Twenty seconds, which covers a config the engine parses and then dies on a
 * few seconds in, and is short enough that an operator who is watching sees
 * the revert happen rather than finding it later.
 */
export const DEFAULT_ENGINE_WATCH: EngineWatchTiming = {
  intervalMs: 2_000,
  durationMs: 20_000,
};

/** How much of the engine's log a revert carries as its reason. */
const LOG_TAIL_LINES = 30;
const LOG_TAIL_BYTES = 4_096;

/** The slice of ContainerControl the watch and the revert use. */
export interface EngineWatcher {
  inspect(profile: string, service: string): Promise<ContainerState | null>;
  logs(profile: string, service: string, tail: number): Promise<string>;
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
      error: profile.engine_config_error,
      references: ENGINE_CONFIG_REFERENCES[engine],
    };
  }

  /**
   * Checks the file, stores it, recreates the engine on it and watches.
   *
   * Everything that can refuse runs before the claim is taken, so a refused
   * save changes nothing. The claim comes before the write, so two saves that
   * both passed the checks cannot both store.
   */
  async apply(name: string, config: string): Promise<ProfileWithContainers> {
    const existing = await this.require(name);
    refuseWhileTransitional(existing);
    const engine = engineOf(existing);
    const version = await this.versions.findById(existing.stack_version_id);
    if (!supportsEngineConfig(version, engine)) {
      throw new ProfileConfigError(name, unsupportedReason(version, engine));
    }
    refuseBySize(name, config);

    const root = await this.orchestrator.stackRootFor(existing);
    const template = engineTemplateIn(root, engine);
    const problem = await this.checker.problem({
      engine,
      config,
      image: version?.contract?.engineImages[engine] ?? null,
      filled: template.placeholders,
      scratchDir: engineConfigDirFor(name),
    });
    if (problem) throw new ProfileConfigError(name, problem);

    const previous = await this.profiles.engineConfigOf(name);
    const row = await this.storeAndRecreate(existing, engine, config, (handle) =>
      this.watchAfter(handle, name, engine, previous),
    );
    return this.containers.withContainers(row);
  }

  /** Back to the version's template, which needs no check and no watch. */
  async reset(name: string): Promise<ProfileWithContainers> {
    const existing = await this.require(name);
    refuseWhileTransitional(existing);
    const engine = engineOf(existing);
    if (!existing.has_engine_config) {
      return this.containers.withContainers(existing);
    }
    const row = await this.storeAndRecreate(existing, engine, null, () => undefined);
    return this.containers.withContainers(row);
  }

  // ---------------------------------------------------------- the rollout

  private async storeAndRecreate(
    existing: Profile,
    engine: EngineName,
    config: string | null,
    onStarted: (handle: RunHandle) => void,
  ): Promise<Profile> {
    const reservation = await this.orchestrator.reserveDeploy(existing, [engine]);

    let row: Profile;
    try {
      const written = await this.profiles.setEngineConfig(existing.name, config, null);
      if (!written) throw new ProfileNotFoundError(existing.name);
      row = written;
    } catch (err) {
      await this.orchestrator.cancelReservation(reservation);
      throw err;
    }

    logger.info(
      `[EngineConfig] ${existing.name}: ${config === null ? 'back to the template' : 'applying a config file'}; recreating ${engine}`,
    );
    await this.publish(row);

    const handle = await this.orchestrator.runReserved(reservation, row);
    onStarted(handle);
    return row;
  }

  private watchAfter(
    handle: RunHandle,
    name: string,
    engine: EngineName,
    previous: string | null,
  ): void {
    handle.emitter.once('done', ({ code }: { code: number }) => {
      // A failed recreate is the orchestrator's to report: the deployment is
      // marked ERROR with the script's own output.
      if (code !== 0) return;
      this.watchEngine(name, engine, previous).catch((err: unknown) => {
        logger.error(`[EngineConfig] the watch on ${name} failed: ${String(err)}`);
      });
    });
  }

  /**
   * Looks at the container every interval for the duration, and reverts the
   * moment it is not a running container that has never restarted. A fresh
   * container's restart count is zero, so any restart is the engine dying on
   * the file.
   */
  private async watchEngine(
    name: string,
    engine: EngineName,
    previous: string | null,
  ): Promise<void> {
    const ticks = Math.max(1, Math.round(this.watch.durationMs / this.watch.intervalMs));
    for (let tick = 0; tick < ticks; tick += 1) {
      await sleep(this.watch.intervalMs);
      const state = await this.control.inspect(name, engine);
      if (state && state.status === 'running' && state.restartCount === 0) continue;
      await this.revert(name, engine, previous, state);
      return;
    }
    logger.info(
      `[EngineConfig] ${name}: ${engine} stayed up on the new config file for ${this.watch.durationMs / 1000} s`,
    );
  }

  private async revert(
    name: string,
    engine: EngineName,
    previous: string | null,
    state: ContainerState | null,
  ): Promise<void> {
    const tail = await this.control
      .logs(name, engine, LOG_TAIL_LINES)
      .catch(() => '');
    const message = revertMessage(engine, state, tail);
    logger.warn(`[EngineConfig] ${name}: ${message.split('\n')[0]}`);

    const row = await this.profiles.setEngineConfig(name, previous, message);
    if (!row) return;
    await this.publish(row);

    try {
      await this.orchestrator.startDeploy(row, [engine]);
    } catch (err) {
      logger.error(
        `[EngineConfig] ${name}: the previous config is stored again but ${engine} could not be recreated on it: ${String(err)}`,
      );
    }
  }

  // ---------------------------------------------------------- the plumbing

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

function revertMessage(
  engine: EngineName,
  state: ContainerState | null,
  tail: string,
): string {
  const lines = tail.trim().slice(-LOG_TAIL_BYTES);
  const head = `${ENGINE_DISPLAY_NAMES[engine]} ${describeState(state)} on the new config file, so the previous one is back.`;
  return lines ? `${head} The engine's last lines:\n${lines}` : head;
}
