import {
  type DeploymentSettingsApplied,
  type DeploymentSettingsCatalog,
  type DeploymentSettingsSave,
  type DeploymentSettingsSaved,
  engineForComponents,
  isSecretSettingKey,
  type NewDeploymentSettingsCatalog,
} from '@streaming-infra-manager/common';

import type { Profile } from '../../types/index.js';
import { TRANSITIONAL_STATUSES } from '../../types/index.js';
import type { ContainerRepository } from '../ContainerRepository.js';
import type { DeploymentOrchestrator } from '../DeploymentOrchestrator.js';
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
import type { ProfileRepository, StackSettingsChange } from '../ProfileRepository.js';
import type { StackVersionRepository } from '../versions/StackVersionRepository.js';

import { deploymentSettingsCatalogOf } from './deploymentSettingsCatalog.js';
import { newDeploymentSettingsCatalogFor, type NewDeploymentShape } from './newDeploymentSettings.js';
import { settingEditProblems } from './settingEditProblems.js';
import { versionSettingsFilesAt } from './versionSettingsFiles.js';

const logger = Logger.getInstance();

/** A deployment on its way out, whose settings no page should still be changing. */
const REMOVING_STATUS = 'REMOVING';

/**
 * A deployment's own stack settings, as its page reads, saves and applies
 * them.
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
    return this.catalogOf(await this.profileNamed(name));
  }

  /** The list a deployment of this version would start with, for the wizard that creates it. Stores and reads nothing of any deployment. */
  async newDeploymentCatalog(versionId: number, shape: NewDeploymentShape): Promise<NewDeploymentSettingsCatalog> {
    const version = await this.versions.findById(versionId);
    if (!version) throw new StackVersionNotFoundError(versionId);
    return newDeploymentSettingsCatalogFor(version, shape);
  }

  /** Stores one save, or refuses all of it, and answers the revision the settings are at now. */
  async save(name: string, save: DeploymentSettingsSave, username: string): Promise<DeploymentSettingsSaved> {
    const profile = await this.profileNamed(name);
    if (profile.instance_id !== save.expectedInstanceId) throw new ProfileInstanceChangedError(name);
    if (profile.status === REMOVING_STATUS) throw new ProfileBusyError(name, profile.status);

    const { entries } = await this.catalogOf(profile);
    const problems = settingEditProblems(save.entries, entries);
    if (problems.length > 0) throw new ProfileConfigError(name, problems.join(' '));

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

    const { drift, running } = await this.catalogOf(profile);
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

  private async catalogOf(profile: Profile): Promise<DeploymentSettingsCatalog> {
    const next = await this.orchestrator.nextEnvFor(profile);
    const stored = await this.profiles.stackSettingsOf(profile.name);
    if (!stored) throw new ProfileNotFoundError(profile.name);
    const engine = engineForComponents(profile.components);
    return deploymentSettingsCatalogOf({
      profile,
      engine,
      contract: next.version.contract,
      buildId: next.version.buildId ?? null,
      ...versionSettingsFilesAt(next.root, engine),
      stored: { plain: stored.plain, secretKeys: stored.secretKeys },
      revision: stored.revision,
      nextEnv: next.env,
      records: await this.containers.listForProfile(profile.name),
      generatedKeys: next.generatedKeys,
      isLocalTarget: isLocalTarget(targetAlias(profile.host)),
    });
  }
}

/** A save as the columns take it: each value by whether its key is a secret, and every reset key. */
function changeOf(save: DeploymentSettingsSave): StackSettingsChange {
  const change: StackSettingsChange = { plain: {}, secret: {}, remove: [] };
  for (const { key, value } of save.entries) {
    if (value === null) change.remove.push(key);
    else if (isSecretSettingKey(key)) change.secret[key] = value;
    else change.plain[key] = value;
  }
  return change;
}
