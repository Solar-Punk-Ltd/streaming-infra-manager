import {
  type DeploymentSettingEdit,
  type DeploymentSettingEntry,
  type DeploymentSettingsCatalog,
  type DeploymentSettingsSave,
  settingValueProblem,
  stackSettingFieldProblem,
} from '@streaming-infra-manager/common';

/**
 * The edit in progress on a deployment's settings, and what of it a save sends.
 *
 * A save carries only the keys the operator changed. Every other key keeps
 * what it has on the manager, so sending one back would rewrite a value
 * nobody touched, and for a key somebody else changed meanwhile, write over
 * their change.
 */

/** What the operator did to one key: typed a value for it, or asked for the version's value back. */
export type SettingEdit = { kind: 'value'; value: string } | { kind: 'reset' };

export interface DeploymentSettingsDraft {
  /**
   * The revision of the list the first edit was made against, or null while
   * nothing is edited. A save names it rather than the revision of the list on
   * screen, so a save that follows another operator's is refused even when
   * the page has read the list again since.
   */
  revision: number | null;
  edits: Readonly<Record<string, SettingEdit>>;
}

export const EMPTY_DRAFT: DeploymentSettingsDraft = { revision: null, edits: {} };

/** Whether the operator types a value for this key here, rather than through the control that decides it. */
export function takesValue(entry: DeploymentSettingEntry): boolean {
  return entry.owner === null && entry.declared;
}

/** Whether there is a value of this deployment's own to take back out. */
export function canReset(entry: DeploymentSettingEntry): boolean {
  return entry.stored;
}

/**
 * What the key's field holds before the operator touches it: the value this
 * deployment stores, else the version's. A secret's field starts empty,
 * because no secret value ever reaches the page, and empty there means keep
 * what is there.
 */
export function valueBeforeEdit(entry: DeploymentSettingEntry): string {
  if (entry.secret) return '';
  return (entry.stored ? entry.storedValue : entry.versionValue) ?? '';
}

/** What the key's field holds with this edit, or with none. */
export function shownValue(entry: DeploymentSettingEntry, edit: SettingEdit | undefined): string {
  if (edit?.kind === 'value') return edit.value;
  if (edit?.kind === 'reset') return entry.secret ? '' : (entry.versionValue ?? '');
  return valueBeforeEdit(entry);
}

function entryOf(catalog: DeploymentSettingsCatalog, key: string): DeploymentSettingEntry | undefined {
  return catalog.entries.find((entry) => entry.key === key);
}

function withEdits(
  draft: DeploymentSettingsDraft,
  catalog: DeploymentSettingsCatalog,
  edits: Record<string, SettingEdit>,
): DeploymentSettingsDraft {
  if (Object.keys(edits).length === 0) return EMPTY_DRAFT;
  return { revision: draft.revision ?? catalog.revision, edits };
}

function without(edits: Readonly<Record<string, SettingEdit>>, key: string): Record<string, SettingEdit> {
  const rest = { ...edits };
  delete rest[key];
  return rest;
}

/**
 * The draft with this value typed for the key. A value that changes nothing,
 * the field's own value back or an empty secret, takes the key out of the
 * draft instead, so the save never sends it.
 */
export function withValue(
  draft: DeploymentSettingsDraft,
  catalog: DeploymentSettingsCatalog,
  key: string,
  value: string,
): DeploymentSettingsDraft {
  const entry = entryOf(catalog, key);
  if (!entry || !takesValue(entry)) return draft;
  if (value === valueBeforeEdit(entry)) return withEdits(draft, catalog, without(draft.edits, key));
  return withEdits(draft, catalog, { ...draft.edits, [key]: { kind: 'value', value } });
}

/** The draft with the key going back to the version's value on save. Only a stored key has one to go back from. */
export function withReset(
  draft: DeploymentSettingsDraft,
  catalog: DeploymentSettingsCatalog,
  key: string,
): DeploymentSettingsDraft {
  const entry = entryOf(catalog, key);
  if (!entry || !canReset(entry)) return draft;
  return withEdits(draft, catalog, { ...draft.edits, [key]: { kind: 'reset' } });
}

/** The draft with whatever was done to this key undone. */
export function withoutEdit(draft: DeploymentSettingsDraft, key: string): DeploymentSettingsDraft {
  if (!(key in draft.edits)) return draft;
  const edits = without(draft.edits, key);
  return Object.keys(edits).length === 0 ? EMPTY_DRAFT : { ...draft, edits };
}

function editSent(entry: DeploymentSettingEntry, edit: SettingEdit | undefined): DeploymentSettingEdit | null {
  if (!edit) return null;
  if (edit.kind === 'reset') return canReset(entry) ? { key: entry.key, value: null } : null;
  if (!takesValue(entry) || edit.value === valueBeforeEdit(entry)) return null;
  return { key: entry.key, value: edit.value };
}

/** What a save sends, one line per changed key, in the order the list gives the keys. */
export function pendingEdits(
  catalog: DeploymentSettingsCatalog,
  draft: DeploymentSettingsDraft,
): DeploymentSettingEdit[] {
  const edits: DeploymentSettingEdit[] = [];
  for (const entry of catalog.entries) {
    const sent = editSent(entry, draft.edits[entry.key]);
    if (sent) edits.push(sent);
  }
  return edits;
}

/**
 * Why the manager would refuse this value for this key, by the same shared
 * rules it applies, or null. A sentence that follows no key starts with "This
 * value", and none repeats a secret.
 */
export function valueProblem(key: string, value: string): string | null {
  const envProblem = settingValueProblem(key, value);
  if (envProblem) return `This value ${envProblem}`;
  return stackSettingFieldProblem(key, value);
}

/** The keys a save would send with a value the manager would refuse, each with the reason. */
export function draftProblems(
  catalog: DeploymentSettingsCatalog,
  draft: DeploymentSettingsDraft,
): Readonly<Record<string, string>> {
  const problems: Record<string, string> = {};
  for (const { key, value } of pendingEdits(catalog, draft)) {
    if (value === null) continue;
    const problem = valueProblem(key, value);
    if (problem) problems[key] = problem;
  }
  return problems;
}

/** The body of `PUT /profiles/:name/settings` for this draft. */
export function saveOf(
  catalog: DeploymentSettingsCatalog,
  draft: DeploymentSettingsDraft,
): DeploymentSettingsSave {
  return {
    expectedInstanceId: catalog.instanceId,
    expectedRevision: draft.revision ?? catalog.revision,
    entries: pendingEdits(catalog, draft),
  };
}
