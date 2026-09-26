import type { DeploymentSettingEntry, NewDeploymentSetting } from '@streaming-infra-manager/common';

import { takesValue, valueBeforeEdit, valueProblem } from './deploymentSettingsDraft';

/**
 * The values typed for a deployment the wizard has not created yet, by key.
 *
 * A key left out takes its version's value, which is what the first deploy
 * writes. Nothing is stored yet, so there is no revision to name and no reset:
 * taking a key out is the whole of going back to the version.
 */
export type NewDeploymentSettingValues = Readonly<Record<string, string>>;

function entryNamed(entries: readonly DeploymentSettingEntry[], key: string): DeploymentSettingEntry | undefined {
  return entries.find((entry) => entry.key === key);
}

/** Whether the list takes a typed value for this key: it names the key and no control decides it. */
function isTaken(entries: readonly DeploymentSettingEntry[], key: string): boolean {
  const entry = entryNamed(entries, key);
  return entry !== undefined && takesValue(entry);
}

/** The values with this key taken out. */
export function withoutNewValue(values: NewDeploymentSettingValues, key: string): NewDeploymentSettingValues {
  if (!(key in values)) return values;
  const rest = { ...values };
  delete rest[key];
  return rest;
}

/**
 * The values with this one typed for the key. A value that changes nothing,
 * the version's own or an empty secret, takes the key out instead, so the
 * create never sends it.
 */
export function withNewValue(
  values: NewDeploymentSettingValues,
  entries: readonly DeploymentSettingEntry[],
  key: string,
  value: string,
): NewDeploymentSettingValues {
  const entry = entryNamed(entries, key);
  if (!entry || !takesValue(entry)) return values;
  if (value === valueBeforeEdit(entry)) return withoutNewValue(values, key);
  return { ...values, [key]: value };
}

/** What the create sends: each typed key the list takes that differs from the version, in the list's order. */
export function newDeploymentSettingsOf(
  entries: readonly DeploymentSettingEntry[],
  values: NewDeploymentSettingValues,
): NewDeploymentSetting[] {
  const sent: NewDeploymentSetting[] = [];
  for (const entry of entries) {
    const value = values[entry.key];
    if (value === undefined || !takesValue(entry) || value === valueBeforeEdit(entry)) continue;
    sent.push({ key: entry.key, value });
  }
  return sent;
}

/**
 * The typed keys the list does not take, which the create leaves out: typed
 * under a version, an engine or a host chosen before, whose list declared them
 * or left them to the operator. Kept rather than dropped, so choosing that
 * again brings them back.
 */
export function valuesNotTaken(entries: readonly DeploymentSettingEntry[], values: NewDeploymentSettingValues): string[] {
  return Object.keys(values).filter((key) => !isTaken(entries, key));
}

/** The keys the create would send with a value the manager would refuse, each with the reason, which never repeats a secret. */
export function newValueProblems(
  entries: readonly DeploymentSettingEntry[],
  values: NewDeploymentSettingValues,
): Readonly<Record<string, string>> {
  const problems: Record<string, string> = {};
  for (const { key, value } of newDeploymentSettingsOf(entries, values)) {
    const problem = valueProblem(key, value);
    if (problem) problems[key] = problem;
  }
  return problems;
}
