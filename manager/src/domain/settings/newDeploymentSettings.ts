import { engineForComponents, type NewDeploymentSettingsCatalog } from '@streaming-infra-manager/common';

import { StackSettingsNotReadyError } from '../errors/StackSettingsNotReadyError.js';
import { isLocalTarget, targetAlias } from '../ports/DeployTargets.js';
import { deployRootProblem, stackRootOf } from '../versions/stackPaths.js';
import type { StackVersionRecord } from '../versions/StackVersionRepository.js';
import { versionSuppliedSecrets } from '../versions/versionSuppliedSecrets.js';

import { newDeploymentSettingsCatalogOf } from './deploymentSettingsCatalog.js';
import { versionSettingsFilesAt } from './versionSettingsFiles.js';

/** The deployment a list is worked out for before it exists, as its create body would describe it. */
export interface NewDeploymentShape {
  kind: string;
  components?: readonly string[] | null;
  /** Where it would deploy. Absent is the manager's own host, as it is for a create. */
  host?: string | null;
}

/**
 * The settings a deployment of this version would start with, before it
 * exists: the list the wizard edits and a create body's `stack_settings` is
 * checked against. Refused, as a deployment's own list is, for a version with
 * no build to read the keys from.
 */
export function newDeploymentSettingsCatalogFor(
  version: StackVersionRecord,
  shape: NewDeploymentShape,
): NewDeploymentSettingsCatalog {
  const problem = deployRootProblem(version);
  if (problem) throw new StackSettingsNotReadyError(version.name, problem);
  const root = stackRootOf(version);
  const engine = engineForComponents(shape.components);
  const required = version.contract?.requiredSecrets ?? [];
  const supplied = versionSuppliedSecrets(root, engine, required);
  return newDeploymentSettingsCatalogOf({
    versionId: version.id,
    contract: version.contract,
    buildId: version.buildId ?? null,
    ...versionSettingsFilesAt(root, engine),
    generatedKeys: required.filter((key) => !supplied.has(key)),
    isLocalTarget: isLocalTarget(targetAlias(shape.host ?? null)),
  });
}

