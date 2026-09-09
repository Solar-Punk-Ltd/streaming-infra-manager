import type {
  StackSettings,
  StackSettingsFileEdit,
} from '@streaming-infra-manager/common';

/**
 * The edit in progress on the settings page, and what of it is sent.
 *
 * A save carries only the keys whose value moved. The manager rewrites those
 * lines and copies every other byte, which is what keeps these files readable
 * over ssh, and sending the whole file back would throw that away for nothing.
 */

export type SettingsDraftFile =
  | { kind: 'env'; values: Record<string, string> }
  | { kind: 'json'; text: string };

/** By relative path, the same paths the manager answered. */
export type SettingsDraft = Record<string, SettingsDraftFile>;

export function draftOf(settings: StackSettings): SettingsDraft {
  const draft: SettingsDraft = {};
  for (const file of settings.files) {
    draft[file.path] =
      file.kind === 'env'
        ? {
            kind: 'env',
            values: Object.fromEntries(file.entries.map((entry) => [entry.key, entry.value])),
          }
        : { kind: 'json', text: file.text };
  }
  return draft;
}

export function withEntry(
  draft: SettingsDraft,
  path: string,
  key: string,
  value: string,
): SettingsDraft {
  const file = draft[path];
  if (file?.kind !== 'env') return draft;
  return { ...draft, [path]: { kind: 'env', values: { ...file.values, [key]: value } } };
}

export function withText(draft: SettingsDraft, path: string, text: string): SettingsDraft {
  const file = draft[path];
  if (file?.kind !== 'json') return draft;
  return { ...draft, [path]: { kind: 'json', text } };
}

/** The files the operator moved, in the order the manager answered them. */
export function editedFiles(
  settings: StackSettings,
  draft: SettingsDraft,
): StackSettingsFileEdit[] {
  const edits: StackSettingsFileEdit[] = [];
  for (const file of settings.files) {
    const edited = draft[file.path];
    if (!edited) continue;
    if (file.kind === 'json' && edited.kind === 'json') {
      if (edited.text !== file.text) edits.push({ path: file.path, text: edited.text });
      continue;
    }
    if (file.kind !== 'env' || edited.kind !== 'env') continue;
    const entries = file.entries
      .filter((entry) => (edited.values[entry.key] ?? entry.value) !== entry.value)
      .map((entry) => ({ key: entry.key, value: edited.values[entry.key] ?? entry.value }));
    if (entries.length > 0) edits.push({ path: file.path, entries });
  }
  return edits;
}

/** Whether this key still holds what the version's own sample assigns it. */
export function isAtSampleValue(entry: { value: string; sampleValue: string | null }): boolean {
  return entry.sampleValue !== null && entry.value === entry.sampleValue;
}

export interface SettingsRefusal {
  message: string;
  /** The label of the action that fixes it, which reloads the settings, or null. */
  retry: string | null;
}

const CHANGED =
  'Somebody changed these settings since you loaded them. Reload to see what they are now, then make your change again.';

/** What a refused save or apply says, from the manager's own error code. */
export function settingsRefusal(code: string | null, message: string): SettingsRefusal {
  if (code === 'settings_changed') return { message: CHANGED, retry: 'Reload' };
  // The manager's own words: they name the lock, what holds it and how to get
  // it back if the editing session that took it is gone.
  if (code === 'settings_locked') return { message, retry: 'Try again' };
  return { message, retry: null };
}
