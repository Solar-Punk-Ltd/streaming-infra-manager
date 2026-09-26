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

/**
 * What names an engine setting's field: its label, then its key, as the row
 * shows them. A screen reader says "Segment length HLS_FRAGMENT", and voice
 * control finds the field by its label, which a name of the key alone did not
 * offer.
 */
export function engineFieldLabelledBy(key: string): string {
  return `${settingLabelId(key)} ${settingKeyId(key)}`;
}
