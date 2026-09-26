import {
  assembleEngineSettingObservations,
  defaultServicesFor,
  type DeploymentSettingsApplied,
  type DeploymentSettingsCatalog,
  type DeploymentSettingsSave,
  type DeploymentSettingsSaved,
  editsEngineSettings,
  engineForComponents,
  engineOfServices,
  engineSettingFieldOf,
  engineSettingsAfterEdits,
  engineSettingsFieldsFor,
  engineSettingsSaveProblem,
  hasBeePublishers,
  isSecretSettingKey,
  type NewDeploymentSettingsCatalog,
  type StackContract,
} from '@streaming-infra-manager/common';

import type { Profile } from '../../types/index.js';
import { TRANSITIONAL_STATUSES } from '../../types/index.js';
import type { ContainerRepository } from '../ContainerRepository.js';
import type { DeploymentOrchestrator } from '../DeploymentOrchestrator.js';
import { deploymentEngineReadings } from '../engineConfig/deploymentEngineReadings.js';
import { engineTemplateTextIn } from '../engineConfig/engineConfigTemplates.js';
import {
  DeploymentSettingsChangedError,
  DeploymentStoppedError,
  ProfileBusyError,
  ProfileConfigError,
  ProfileInstanceChangedError,
  ProfileNotFoundError,
  StackVersionNotFoundError,
} from '../errors/index.js';
import { Logger } from '../Logger.js';
import { isLocalTarget, targetAlias } from '../ports/DeployTargets.js';
import type { ProfileRepository, StackSettingsChange, StoredStackSettings } from '../ProfileRepository.js';
import type { StackVersionRepository } from '../versions/StackVersionRepository.js';

import { type DeploymentEngineSettings, deploymentSettingsCatalogOf } from './deploymentSettingsCatalog.js';
import { engineDefaultsAt } from './engineHostDefaults.js';
import { newDeploymentSettingsCatalogFor, type NewDeploymentShape } from './newDeploymentSettings.js';
import { settingEditProblems } from './settingEditProblems.js';
import { versionSettingsFilesAt } from './versionSettingsFiles.js';

const logger = Logger.getInstance();

/** A deployment on its way out, whose settings no page should still be changing. */
const REMOVING_STATUS = 'REMOVING';

/** A deployment's list as one read of what it stores saw it, with the engine settings the list was worked out from. */
interface ReadSettings {
  catalog: DeploymentSettingsCatalog;
  stored: StoredStackSettings;
  engineSettings: DeploymentEngineSettings | null;
}

/**
 * A deployment's own stack settings, as its page reads, saves and applies
 * them, its engine settings among them.
 *
 * A save stores and changes nothing that runs. The page then shows which
 * settings the running containers are behind on, and Apply redeploys the
 * containers that read them, or everything when a key reaches the deploy
 * scripts alone. A stopped deployment's Start uses the stored values anyway.
 */
export class DeploymentSettingsService {
  constructor(
    private readonly profiles: ProfileRepository,
    private readonly containers: ContainerRepository,
    private readonly orchestrator: DeploymentOrchestrator,
    private readonly versions: Pick<StackVersionRepository, 'findById'>,
  ) {}

  async catalog(name: string): Promise<DeploymentSettingsCatalog> {
    return (await this.read(await this.profileNamed(name))).catalog;
  }

  /** The list a deployment of this version would start with, for the wizard that creates it. Stores and reads nothing of any deployment. */
  async newDeploymentCatalog(versionId: number, shape: NewDeploymentShape): Promise<NewDeploymentSettingsCatalog> {
    const version = await this.versions.findById(versionId);
    if (!version) throw new StackVersionNotFoundError(versionId);
    return newDeploymentSettingsCatalogFor(version, shape);
  }

  /**
   * Stores one save, or refuses all of it, and answers the revision the
   * settings are at now. An engine setting goes to the engine settings, held
   * to the engine's own rules with what the rest of them will be once the
   * save lands, and the stack keys and the engine settings of one save move
   * the revision once, together.
   */
  async save(name: string, save: DeploymentSettingsSave, username: string): Promise<DeploymentSettingsSaved> {
    const profile = await this.profileNamed(name);
    if (profile.instance_id !== save.expectedInstanceId) throw new ProfileInstanceChangedError(name);
    if (profile.status === REMOVING_STATUS) throw new ProfileBusyError(name, profile.status);

    const { catalog, stored, engineSettings } = await this.read(profile);
    const problems = settingEditProblems(save.entries, catalog.entries);
    if (problems.length > 0) throw new ProfileConfigError(name, problems.join(' '));
    // The engine settings are judged as this read found them, which is only
    // what the page saw while the revision it names is still this one.
    if (stored.revision !== save.expectedRevision) throw new DeploymentSettingsChangedError(name);
    const engineProblem = engineSaveProblem(save, stored, engineSettings);
    if (engineProblem) throw new ProfileConfigError(name, engineProblem);

    const revision = await this.profiles.updateStackSettings(name, changeOf(save), {
      instanceId: save.expectedInstanceId,
      expectedRevision: save.expectedRevision,
    });
    if (revision === null) {
      const current = await this.profiles.findByName(name);
      if (!current || current.instance_id !== save.expectedInstanceId) throw new ProfileInstanceChangedError(name);
      throw new DeploymentSettingsChangedError(name);
    }
    // Keys only. A value can be a secret, and the log is read far more widely than the page.
    logger.info(
      `[DeploymentSettings] ${username} saved ${save.entries.map(({ key }) => key).join(', ')} for ${name}, now at revision ${revision}`,
    );
    return { revision };
  }

  /**
   * Redeploys the containers that are behind on a setting, or all of them when
   * a changed key reaches the deploy scripts alone, and answers which.
   */
  async apply(name: string, expectedInstanceId: string, username: string): Promise<DeploymentSettingsApplied> {
    const profile = await this.profileNamed(name);
    if (profile.instance_id !== expectedInstanceId) throw new ProfileInstanceChangedError(name);
    if ((TRANSITIONAL_STATUSES as readonly string[]).includes(profile.status)) {
      throw new ProfileBusyError(name, profile.status);
    }

    const { drift, running } = (await this.read(profile)).catalog;
    if (!running) throw new DeploymentStoppedError(name);
    if (drift.keys.length === 0) return { recreated: [] };

    const services = drift.fullRedeploy ? undefined : drift.services;
    await this.orchestrator.startDeploy(profile, services);
    logger.info(
      `[DeploymentSettings] ${username} applied ${drift.keys.join(', ')} to ${name}, recreating ${services?.join(', ') ?? 'every service'}`,
    );
    return { recreated: services ?? 'all' };
  }

  private async profileNamed(name: string): Promise<Profile> {
    const profile = await this.profiles.findByName(name);
    if (!profile) throw new ProfileNotFoundError(name);
    return profile;
  }

  private async read(profile: Profile): Promise<ReadSettings> {
    const next = await this.orchestrator.nextEnvFor(profile);
    const stored = await this.profiles.stackSettingsOf(profile.name);
    if (!stored) throw new ProfileNotFoundError(profile.name);
    const engine = engineForComponents(profile.components);
    const engineSettings = await this.engineSettingsOf(profile, stored, next.root, next.version.contract);
    const catalog = deploymentSettingsCatalogOf({
      profile,
      engine,
      contract: next.version.contract,
      buildId: next.version.buildId ?? null,
      ...versionSettingsFilesAt(next.root, engine),
      stored: { plain: stored.plain, secretKeys: stored.secretKeys },
      engineSettings,
      revision: stored.revision,
      nextEnv: next.env,
      records: await this.containers.listForProfile(profile.name),
      generatedKeys: next.generatedKeys,
      isLocalTarget: isLocalTarget(targetAlias(profile.host)),
    });
    return { catalog, stored, engineSettings };
  }

  /**
   * The engine settings of a deployment that runs a media server: the fields
   * it reads, what it stores, its host's defaults and the settings the config
   * its engine runs no longer reads, worked out as the Engine card works them
   * out. Null for a deployment that runs none.
   */
  private async engineSettingsOf(
    profile: Profile,
    stored: StoredStackSettings,
    root: string,
    contract: StackContract | null | undefined,
  ): Promise<DeploymentEngineSettings | null> {
    const engine = engineOfServices(defaultServicesFor(profile));
    if (!engine) return null;
    const abr = hasBeePublishers(profile);
    const fields = engineSettingsFieldsFor(engine, { abr });
    const defaults = engineDefaultsAt(root, engine, contract);
    const own = profile.has_engine_config ? await this.profiles.engineConfigOf(profile.name) : null;
    const readings = deploymentEngineReadings(
      engine,
      fields,
      { template: engineTemplateTextIn(root, engine), hasOwn: profile.has_engine_config, own },
      { abr },
    );
    const { notInConfig } = assembleEngineSettingObservations({ fields, settings: stored.engine, defaults, readings });
    return { engine, abr, stored: stored.engine, defaults, notInConfig };
  }
}

/**
 * Why the engine would refuse the engine settings a save leaves stored, with
 * the host's default for any key they leave unset, or null. A save that names
 * no engine setting is not held to them, so a stack key can still be saved
 * while the engine settings wait for a fix.
 */
function engineSaveProblem(
  save: DeploymentSettingsSave,
  stored: StoredStackSettings,
  engineSettings: DeploymentEngineSettings | null,
): string | null {
  if (!engineSettings || !editsEngineSettings(save.entries)) return null;
  return engineSettingsSaveProblem(engineSettings.engine, engineSettingsAfterEdits(stored.engine, save.entries), {
    abr: engineSettings.abr,
    defaults: engineSettings.defaults.values,
  });
}

/**
 * A save as the columns take it: an engine setting to the engine settings,
 * any other value by whether its key is a secret, and every reset key out of
 * wherever it is kept.
 */
function changeOf(save: DeploymentSettingsSave): StackSettingsChange {
  const change: StackSettingsChange = { plain: {}, secret: {}, remove: [], engine: { set: {}, remove: [] } };
  for (const { key, value } of save.entries) {
    if (engineSettingFieldOf(key)) {
      if (value === null) change.engine.remove.push(key);
      else change.engine.set[key] = value;
    } else if (value === null) change.remove.push(key);
    else if (isSecretSettingKey(key)) change.secret[key] = value;
    else change.plain[key] = value;
  }
  return change;
}
