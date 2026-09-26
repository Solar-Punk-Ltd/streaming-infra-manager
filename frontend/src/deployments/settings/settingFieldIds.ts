/** The id of the field that edits a key, which the page focuses a revealed setting by. */
export function settingFieldId(key: string): string {
  return `deployment-setting-${key}`;
}

/** The id of the label an engine setting's row shows above its field. */
export function settingLabelId(key: string): string {
  return `${settingFieldId(key)}-label`;
}

/** The id of the key an engine setting's row shows beside its label. */
export function settingKeyId(key: string): string {
  return `${settingFieldId(key)}-key`;
}

/** The id of the line under a key's field, its hint or a refusal. */
export function settingHelperTextId(key: string): string {
  return `${settingFieldId(key)}-helper-text`;
}

/** The id of the line that names the default a reset of a key goes back to. */
export function settingDefaultId(key: string): string {
  return `${settingFieldId(key)}-default`;
}

/**
 * What describes an engine setting's field: the line under it while one
 * shows, then the default, so a screen reader hears what the field takes and
 * what a reset goes back to, as the row shows both.
 */
export function engineFieldDescribedBy(key: string, shows: { helperText: boolean }): string {
  return shows.helperText ? `${settingHelperTextId(key)} ${settingDefaultId(key)}` : settingDefaultId(key);
}

/**
 * What names an engine setting's field: its label, then its key, as the row
 * shows them. A screen reader says "Segment length HLS_FRAGMENT", and voice
 * control finds the field by its label, which a name of the key alone did not
 * offer.
 */
export function engineFieldLabelledBy(key: string): string {
  return `${settingLabelId(key)} ${settingKeyId(key)}`;
}
