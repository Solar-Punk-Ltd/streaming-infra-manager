import type {
  DeploymentSettingsApplied,
  DeploymentSettingsCatalog,
  DeploymentSettingsSave,
  DeploymentSettingsSaved,
  NewDeploymentSettingsCatalog,
} from '@streaming-infra-manager/common';

import { getJson, sendJson } from '../../http';
import type { ProfileKind } from '../../types';

/**
 * A deployment's own stack settings, over the routes of
 * `manager/src/api/routes/deploymentSettings.ts`: its list, a save and Apply,
 * and the list a deployment not created yet starts with.
 *
 * No list carries a secret's value, only whether one is stored or set, and
 * nothing here ever writes a value to the console.
 */

/** The deployment a new-deployment list is asked for, as its create body will describe it. */
export interface NewDeploymentShape {
  kind: ProfileKind;
  /** Null where the kind decides the services. */
  components: readonly string[] | null;
  /** Where it deploys, which decides whether the manager keeps its data directories. */
  host: string;
}

/** The query of `GET /versions/:id/settings-catalog` for this version and shape. */
export function newDeploymentSettingsPath(versionId: number, shape: NewDeploymentShape): string {
  const query = new URLSearchParams({ kind: shape.kind, host: shape.host });
  if (shape.components && shape.components.length > 0) query.set('components', shape.components.join(','));
  return `/versions/${versionId}/settings-catalog?${query.toString()}`;
}

export function fetchNewDeploymentSettings(path: string, signal?: AbortSignal): Promise<NewDeploymentSettingsCatalog> {
  return getJson<NewDeploymentSettingsCatalog>(path, { cache: 'no-store', signal });
}

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

/** Recreates the containers that are behind on a saved setting, or redeploys every service when one reaches the deploy scripts alone. */
export function applyDeploymentSettings(name: string, expectedInstanceId: string): Promise<DeploymentSettingsApplied> {
  return sendJson<DeploymentSettingsApplied>('POST', `${settingsPath(name)}/apply`, { expectedInstanceId });
}
