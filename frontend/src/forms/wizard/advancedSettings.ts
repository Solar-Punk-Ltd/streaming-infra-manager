import type { NewDeploymentSetting } from '@streaming-infra-manager/common';

import { newDeploymentSettingsPath } from '../../deployments/settings/deploymentSettingsApi';
import {
  newDeploymentSettingsOf,
  newValueProblems,
  valuesNotTaken,
} from '../../deployments/settings/newDeploymentSettingsDraft';
import { newDeploymentSettingsNote, notTakenNote, wordList } from '../../deployments/settings/settingsText';
import { SEGMENT_LENGTH_FIELD } from './segmentLength';
import {
  chosenHost,
  createdShapeOf,
  offersSegmentLength,
  SETTINGS_STEP,
  type WizardContext,
  type WizardState,
} from './wizardState';

/**
 * The wizard's Advanced settings: every key the chosen version declares, for
 * the deployment it is about to create, with the version's value as the
 * default (Levi, 2026-09-25, plan item C.5). The typed values live in
 * `WizardState.stackSettings`, and the list they are checked against is read
 * by the dialog for the choices on screen.
 */

const PREFIX = 'Advanced settings: ';
const READING = "reading this version's settings";

function hasTypedValues(state: WizardState): boolean {
  return Object.keys(state.stackSettings).length > 0;
}

/**
 * Where the list for the choices on screen is read from, or null before the
 * settings step, where the version and the host can still change with every
 * keystroke, and without a goal or a version to ask about.
 */
export function newDeploymentSettingsPathOf(state: WizardState): string | null {
  if (state.step < SETTINGS_STEP || !state.goal || state.versionId === null) return null;
  return newDeploymentSettingsPath(state.versionId, { ...createdShapeOf(state), host: chosenHost(state) });
}

/**
 * What the wizard's own fields give the keys a control decides, by key, shown
 * on those keys' rows so the two never read differently. The segment length
 * is the one field that decides a listed key, `HLS_FRAGMENT`, which the engine
 * settings own and the list shows without a field of its own.
 */
export function controlValuesOf(state: WizardState): Readonly<Record<string, string>> {
  const seconds = state.segmentSeconds.trim();
  return offersSegmentLength(state) && seconds ? { [SEGMENT_LENGTH_FIELD.key]: seconds } : {};
}

/**
 * What stops Continue on the settings step and Deploy on the review, or null.
 * Typed values are checked only against a list read for the choices on
 * screen, so none is sent unchecked, and a refusal names keys alone.
 */
export function advancedSettingsError(state: WizardState, context: WizardContext): string | null {
  if (!hasTypedValues(state)) return null;
  const load = context.newDeploymentSettings;
  if (!load?.catalog) return `${PREFIX}${load?.failure?.message ?? READING}`;
  const refused = Object.keys(newValueProblems(load.catalog.entries, state.stackSettings));
  return refused.length > 0 ? `${PREFIX}${newDeploymentSettingsNote(0, refused)}` : null;
}

/**
 * The `stack_settings` of the create body: the typed keys the list for these
 * choices takes, or nothing. Refused rather than sent unchecked when values
 * are typed and no list was read for these choices, which the footer already
 * stops, so this is the last guard rather than the rule.
 */
export function advancedSettingsBody(state: WizardState, context: WizardContext): NewDeploymentSetting[] | undefined {
  if (!hasTypedValues(state)) return undefined;
  const catalog = context.newDeploymentSettings?.catalog;
  if (!catalog) throw new Error(`${PREFIX}${READING}. Try again in a moment.`);
  const settings = newDeploymentSettingsOf(catalog.entries, state.stackSettings);
  return settings.length > 0 ? settings : undefined;
}

/** The line on the folded Advanced settings: what it holds, or what the create sends from it. */
export function advancedSettingsFoldLine(state: WizardState, context: WizardContext): string {
  if (!hasTypedValues(state)) {
    return "Every key this version declares, for this deployment alone. Left alone, each keeps the version's value.";
  }
  const catalog = context.newDeploymentSettings?.catalog;
  if (!catalog) return "Reading this version's settings.";
  const sent = newDeploymentSettingsOf(catalog.entries, state.stackSettings);
  return newDeploymentSettingsNote(sent.length, Object.keys(newValueProblems(catalog.entries, state.stackSettings)));
}

/** The review's line for the advanced settings, naming keys and never a value, or null when none is typed. */
export function advancedSettingsSummary(state: WizardState, context: WizardContext): string | null {
  if (!hasTypedValues(state)) return null;
  const catalog = context.newDeploymentSettings?.catalog;
  if (!catalog) return "Reading this version's settings.";
  const sent = newDeploymentSettingsOf(catalog.entries, state.stackSettings).map(({ key }) => key);
  const notTaken = valuesNotTaken(catalog.entries, state.stackSettings);
  const parts =
    sent.length > 0
      ? [`${wordList(sent)} set for this deployment.`, "Every other key keeps the version's value."]
      : ["Every key keeps the version's value."];
  if (notTaken.length > 0) parts.push(notTakenNote(notTaken));
  return parts.join(' ');
}
