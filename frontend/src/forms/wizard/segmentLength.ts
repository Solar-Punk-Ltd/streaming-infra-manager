import {
  type EngineSettingField,
  type EngineSettings,
  engineSettingFieldProblem,
  engineSettingsFields,
  SRS_SERVICE,
} from '@streaming-infra-manager/common';

/**
 * The one engine setting the wizard offers, and what a new deployment starts
 * at.
 *
 * Read off the shared field list rather than written here, so the number the
 * wizard shows is the manager's own default and the wizard, the settings
 * drawer and the create body cannot disagree about it. Everything else about
 * the engine stays in the drawer, where a running deployment's settings belong.
 */
export const SEGMENT_LENGTH_FIELD: EngineSettingField = engineSettingsFields(
  SRS_SERVICE,
).find((field) => field.key === 'HLS_FRAGMENT')!;

/**
 * What is wrong with the typed segment length, in the drawer's own words, or
 * null.
 *
 * An empty field is not wrong. It means send nothing, which leaves the
 * deployment on whatever its stack version's entrypoints fall back to, and it
 * is what the field's own message tells an operator clearing it does.
 */
export function segmentLengthError(value: string): string | null {
  return value.trim() ? engineSettingFieldProblem(SEGMENT_LENGTH_FIELD, value) : null;
}

/** The engine settings the create body carries for it, or nothing. */
export function segmentLengthSettings(
  value: string,
): EngineSettings | undefined {
  const seconds = value.trim();
  return seconds ? { [SEGMENT_LENGTH_FIELD.key]: seconds } : undefined;
}
