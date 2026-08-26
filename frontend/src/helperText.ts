type FieldError = string | null | undefined | false;

export const nameHelperText = (
  error: FieldError,
  isEdit: boolean,
  groupMode: boolean,
): string =>
  error ||
  (isEdit
    ? 'locked — names are immutable'
    : groupMode
      ? 'members will be named <group>-profile-1, <group>-profile-2, …'
      // ABR pools name members <pool>-<rung> and use their own form; see
      // AbrPoolForm, which supplies its own helper text.
      : 'e.g. viewer-alpha');

export const groupSizeHelperText = (
  error: FieldError,
  groupSize: number,
): string =>
  error ||
  (groupSize > 20
    ? `${groupSize} profiles will be created and deployed — large group, double-check before submitting`
    : 'number of deployments to create');

export const kindHelperText = (
  isEdit: boolean,
  kindHint: string | undefined,
): string | undefined =>
  isEdit ? 'locked — kind cannot change after first deploy' : kindHint;

export const componentsHelperText = (
  error: FieldError,
  isEdit: boolean,
  isCustom: boolean,
): string =>
  error ||
  (isEdit
    ? 'locked — components cannot change after first deploy'
    : isCustom
      ? 'pick any combination'
      : 'locked by kind');

export const hostHelperText = (error: FieldError, isEdit: boolean): string =>
  error ||
  (isEdit
    ? 'locked — host cannot change after first deploy (data is not migrated)'
    : 'optional — defaults to "localhost"');

export const privateKeyHelperText = (error: FieldError): string =>
  error || 'optional — 0x + 64 hex chars';

export const publicKeyHelperText = (derivedAddress: string | null): string =>
  derivedAddress
    ? 'derived from private key'
    : 'will appear once a valid private key is entered';

export const stampIdHelperText = (error: FieldError): string =>
  error || 'optional — add later; uploader waits until a stamp is set';

export const feedOwnerHelperText = (error: FieldError): string =>
  error || '0x-prefixed Ethereum address';

export const notesHelperText = (error: FieldError, length: number): string =>
  error || `${length}/500`;
