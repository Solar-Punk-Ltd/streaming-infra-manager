import type {
  DeploymentSettingsApplied,
  DeploymentSettingsCatalog,
  DeploymentSettingsSave,
  DeploymentSettingsSaved,
} from '@streaming-infra-manager/common';

import { getJson, sendJson } from '../../http';

/**
 * A deployment's own stack settings, over the three routes of
 * `manager/src/api/routes/deploymentSettings.ts`.
 *
 * The list never carries a secret's value, only whether one is stored, and
 * nothing here ever writes a value to the console.
 */

function settingsPath(name: string): string {
  return `/profiles/${encodeURIComponent(name)}/settings`;
}

export function fetchDeploymentSettings(name: string, signal?: AbortSignal): Promise<DeploymentSettingsCatalog> {
  return getJson<DeploymentSettingsCatalog>(settingsPath(name), { cache: 'no-store', signal });
}

/** Stores the changed keys and runs nothing. Refused whole when one of them is refused. */
export function saveDeploymentSettings(name: string, save: DeploymentSettingsSave): Promise<DeploymentSettingsSaved> {
  return sendJson<DeploymentSettingsSaved>('PUT', settingsPath(name), save);
}

/** Recreates the containers that are behind on a saved setting, or every one when that cannot be told. */
export function applyDeploymentSettings(name: string, expectedInstanceId: string): Promise<DeploymentSettingsApplied> {
  return sendJson<DeploymentSettingsApplied>('POST', `${settingsPath(name)}/apply`, { expectedInstanceId });
}
