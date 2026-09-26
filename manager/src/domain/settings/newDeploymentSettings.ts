import {
  ADMIN_API_TOKEN_KEY,
  ADMIN_API_URL_KEY,
  adminLinkEditProblem,
  adminOriginOf,
  type DeploymentSettingEntry,
  type EngineName,
  engineForComponents,
  isSecretSettingKey,
  type NewDeploymentSetting,
  type NewDeploymentSettingsCatalog,
} from '@streaming-infra-manager/common';

import { ProfileConfigError } from '../errors/ProfileConfigError.js';
import { StackSettingsNotReadyError } from '../errors/StackSettingsNotReadyError.js';
import { isLocalTarget, targetAlias } from '../ports/DeployTargets.js';
import { type InitialStackSettings, NO_STACK_SETTINGS } from '../ProfileRepository.js';
import { deployRootProblem, stackRootOf } from '../versions/stackPaths.js';
import type { StackVersionRecord } from '../versions/StackVersionRepository.js';
import { versionSuppliedSecrets } from '../versions/versionSuppliedSecrets.js';

import { adminLinkBeforeOf } from './adminLinkBefore.js';
import { newDeploymentSettingsCatalogOf } from './deploymentSettingsCatalog.js';
import { settingEditProblems } from './settingEditProblems.js';
import { type VersionSettingsFiles, versionSettingsFilesAt, versionValuesOf } from './versionSettingsFiles.js';

/** The deployment a list is worked out for before it exists, as its create body would describe it. */
export interface NewDeploymentShape {
  kind: string;
  components?: readonly string[] | null;
  /** Where it would deploy. Absent is the manager's own host, as it is for a create. */
  host?: string | null;
}

/** What a deployment not created yet is worked out from: its version's build, for the engine it would run. */
interface NewDeploymentSources {
  root: string;
  engine: EngineName;
  files: VersionSettingsFiles;
  /** The secrets the version requires, which the manager generates at the first deploy where the version leaves one empty. */
  required: readonly string[];
}

/** Refused, as a deployment's own list is, for a version with no build to read the keys from. */
function sourcesOf(version: StackVersionRecord, shape: NewDeploymentShape): NewDeploymentSources {
  const problem = deployRootProblem(version);
  if (problem) throw new StackSettingsNotReadyError(version.name, problem);
  const root = stackRootOf(version);
  const engine = engineForComponents(shape.components);
  return { root, engine, files: versionSettingsFilesAt(root, engine), required: version.contract?.requiredSecrets ?? [] };
}

function catalogOf(version: StackVersionRecord, shape: NewDeploymentShape, sources: NewDeploymentSources): NewDeploymentSettingsCatalog {
  const supplied = versionSuppliedSecrets(sources.root, sources.engine, sources.required);
  return newDeploymentSettingsCatalogOf({
    versionId: version.id,
    contract: version.contract,
    buildId: version.buildId ?? null,
    ...sources.files,
    generatedKeys: sources.required.filter((key) => !supplied.has(key)),
    isLocalTarget: isLocalTarget(targetAlias(shape.host ?? null)),
  });
}

/**
 * The settings a deployment of this version would start with, before it
 * exists: the list the wizard edits and a create body's `stack_settings` is
 * checked against.
 */
export function newDeploymentSettingsCatalogFor(
  version: StackVersionRecord,
  shape: NewDeploymentShape,
): NewDeploymentSettingsCatalog {
  return catalogOf(version, shape, sourcesOf(version, shape));
}

/**
 * Why the manager's stored web2 admin token cannot be copied into a
 * deployment created with these settings, or null: the create types a token
 * of its own too, or the version gives the operator no `ADMIN_API_TOKEN` to set.
 */
function managerTokenProblem(settings: readonly NewDeploymentSetting[], entries: readonly DeploymentSettingEntry[]): string | null {
  if (settings.some(({ key }) => key === ADMIN_API_TOKEN_KEY)) {
    return `${ADMIN_API_TOKEN_KEY} is typed for this deployment and also asked for from the manager's stored token. Send one of the two.`;
  }
  const entry = entries.find(({ key }) => key === ADMIN_API_TOKEN_KEY);
  if (!entry?.declared) return `${ADMIN_API_TOKEN_KEY} is not a setting this deployment's version declares, so the manager's stored token has nowhere to go.`;
  if (entry.owner !== null) return `${ADMIN_API_TOKEN_KEY} is not one this deployment sets, so the manager's stored token has nowhere to go.`;
  return null;
}

/**
 * The stack settings a new deployment is created with, held to the rules a
 * save of its settings page is held to, against the list its version gives a
 * deployment of this shape, and split the way the two columns hold them. That
 * includes the web2 admin rule, judged on what the version gives the two keys
 * and what the create sets for them, the manager's stored token counted when
 * the create asks for it. Refused whole, each key named and no secret
 * repeated. A create that names none and asks for nothing reads nothing, so
 * it is never refused over a version's files.
 *
 * @param copyManagerAdminToken whether the insert copies the manager's stored
 *   web2 admin token into the deployment, which never passes through here.
 */
export function initialStackSettingsFor(
  name: string,
  version: StackVersionRecord,
  shape: NewDeploymentShape,
  settings: readonly NewDeploymentSetting[],
  copyManagerAdminToken = false,
): InitialStackSettings {
  if (settings.length === 0 && !copyManagerAdminToken) return NO_STACK_SETTINGS;
  const sources = sourcesOf(version, shape);
  const { entries } = catalogOf(version, shape, sources);
  const problems = settingEditProblems(settings, entries);
  const tokenProblem = copyManagerAdminToken ? managerTokenProblem(settings, entries) : null;
  if (tokenProblem) problems.push(tokenProblem);
  if (problems.length > 0) throw new ProfileConfigError(name, problems.join(' '));
  const versionValues = versionValuesOf(sources.files);
  const before = adminLinkBeforeOf({ current: versionValues, version: versionValues, requiredSecrets: sources.required });
  const token = copyManagerAdminToken ? { current: true, afterReset: true } : before.token;
  const adminProblem = adminLinkEditProblem(settings, { ...before, token });
  if (adminProblem) throw new ProfileConfigError(name, adminProblem);
  const values = Object.fromEntries(settings.map(({ key, value }) => [key, value]));
  const initial = initialStackSettingsOf(values);
  const url = values[ADMIN_API_URL_KEY] ?? versionValues[ADMIN_API_URL_KEY] ?? '';
  const adminTokenOrigin = adminOriginOf(url) ?? '';
  if (copyManagerAdminToken) return { ...initial, copyManagerAdminToken: { url }, adminTokenOrigin };
  return values[ADMIN_API_TOKEN_KEY] ? { ...initial, adminTokenOrigin } : initial;
}

/** Values by key, split the way the two columns hold them: a secret apart from the rest. */
export function initialStackSettingsOf(values: Readonly<Record<string, string>>): InitialStackSettings {
  const plain: Record<string, string> = {};
  const secret: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (isSecretSettingKey(key)) secret[key] = value;
    else plain[key] = value;
  }
  return { plain, secret };
}
