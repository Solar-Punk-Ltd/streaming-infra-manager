import {
  type DeploymentSettingEdit,
  type DeploymentSettingEntry,
  engineSettingFieldOf,
  engineSettingFieldProblem,
  isNotReadOwner,
  SETTING_OWNER_LABELS,
  type SettingOwner,
  settingValueProblem,
  stackSettingFieldProblem,
} from '@streaming-infra-manager/common';

/**
 * Why a save of a deployment's settings is refused, one sentence per problem,
 * or none. Checked against the deployment's own settings list, which says
 * which keys its version declares, which the deployment stores, and which a
 * control of the deployment's own decides.
 *
 * A sentence names the key and never repeats a secret: the env value rule
 * says nothing of the value, and a field's rule repeats one only for a list,
 * a switch or a number, which no secret is. An engine setting the list lets the
 * operator set is held to the engine's own rule for that field, and its
 * sentence carries the key in front of the field's own words.
 */
export function settingEditProblems(
  edits: readonly DeploymentSettingEdit[],
  entries: readonly DeploymentSettingEntry[],
): string[] {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const { key, value } of edits) {
    if (seen.has(key)) {
      problems.push(`${key} is named twice in this save.`);
      continue;
    }
    seen.add(key);
    const problem = editProblem(key, value, byKey.get(key));
    if (problem) problems.push(problem);
  }
  return problems;
}

function ownerRefusal(key: string, owner: SettingOwner): string {
  return isNotReadOwner(owner)
    ? `${key} cannot be set here, because ${SETTING_OWNER_LABELS[owner]}.`
    : `${key} is set by ${SETTING_OWNER_LABELS[owner]}, not here.`;
}

function editProblem(key: string, value: string | null, entry: DeploymentSettingEntry | undefined): string | null {
  if (!entry) return `${key} is not a setting this deployment's version declares.`;
  if (value === null) return null;
  if (entry.owner !== null) return ownerRefusal(key, entry.owner);
  if (!entry.declared) {
    return `${key} is stored for this deployment, but its version no longer declares it. Reset it rather than set it.`;
  }
  const engineField = engineSettingFieldOf(key);
  if (engineField) {
    const problem = engineSettingFieldProblem(engineField, value);
    return problem ? `${key}: ${problem}` : null;
  }
  const valueProblem = settingValueProblem(key, value);
  if (valueProblem) return `${key} ${valueProblem}`;
  return stackSettingFieldProblem(key, value);
}
