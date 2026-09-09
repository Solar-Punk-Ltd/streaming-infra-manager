/**
 * A version's host-owned settings as the manager answers them and the settings
 * page edits them.
 *
 * The three files are the operator's: the base `.env`, `deploy/config.json` and
 * one `.env` per engine. They live beside the version's checkout, they survive
 * every build, and a build copies the revision current when it published into
 * its own immutable tree. So what this page saves reaches new deployments only
 * once a build has captured it, which is what Apply does.
 *
 * The two rules below are here rather than in the manager or the page because
 * both sides apply them: the page masks a secret and the manager decides by
 * the same names which values it must never log.
 */

/** One assignment of an env file, in the order the version's sample declares it. */
export interface StackSettingsEntry {
  key: string;
  /** The file's own value, as it stands after the `=`. Empty for a key the file leaves unset. */
  value: string;
  /** What the version's sample assigns, or null for a key the sample does not declare. */
  sampleValue: string | null;
  /** The sample's comment block above the key, the `#` stripped and the lines joined. */
  description: string;
  /** Masked by the page until it is revealed. */
  secret: boolean;
  /** The manager fills this per deployment while the version leaves it empty. */
  generated: boolean;
}

export interface StackSettingsEnvFile {
  /** Relative posix path inside the version's config root. */
  path: string;
  kind: 'env';
  entries: StackSettingsEntry[];
}

export interface StackSettingsJsonFile {
  path: string;
  kind: 'json';
  text: string;
  /** The version's own `deploy/config.sample.json`, for the page's reset action, or null. */
  sampleText: string | null;
}

export type StackSettingsFile = StackSettingsEnvFile | StackSettingsJsonFile;

/** What `GET /versions/:id/settings` answers. */
export interface StackSettings {
  /** The revision these files are at. A save is refused unless it names this one. */
  generation: number;
  /** The build the samples and descriptions were read from, or null. */
  buildId: string | null;
  files: StackSettingsFile[];
}

export interface StackSettingsEntryEdit {
  key: string;
  value: string;
  /** Deletes the key's line instead of assigning it. */
  remove?: boolean;
}

export interface StackSettingsEnvEdit {
  path: string;
  entries: StackSettingsEntryEdit[];
}

export interface StackSettingsJsonEdit {
  path: string;
  text: string;
}

export type StackSettingsFileEdit = StackSettingsEnvEdit | StackSettingsJsonEdit;

/** What `PUT /versions/:id/settings` takes. */
export interface StackSettingsSave {
  expectedGeneration: number;
  files: StackSettingsFileEdit[];
}

/** What a save answers: the revision the files are at now. */
export interface StackSettingsSaved {
  generation: number;
}

/** What `POST /versions/:id/settings/apply` answers: the build new deployments get. */
export interface StackSettingsApplied {
  buildId: string;
}

// ------------------------------------------------------------- the secrets

/**
 * The secret-like keys the stack ships today, held by name.
 *
 * The suffix rule below covers all six, and naming them anyway is deliberate:
 * a narrower suffix rule would otherwise unmask one of these silently, and
 * these are the six whose values are worth the most to whoever reads them.
 */
export const NAMED_SECRET_SETTING_KEYS: readonly string[] = [
  'STREAM_KEY',
  'API_AUTH_TOKEN',
  'PUBLISH_KEY_SECRET',
  'SRT_PASSPHRASE',
  'SRS_WEBHOOK_TOKEN',
  'OME_ADMISSION_SECRET',
];

/** What a key ending in one of these holds is a secret whatever version declares it. */
const SECRET_KEY_SUFFIXES: readonly string[] = [
  '_TOKEN',
  '_SECRET',
  '_PASSPHRASE',
  '_PASSWORD',
  '_KEY',
];

/** Whether a settings key holds a value the page masks until it is revealed. */
export function isSecretSettingKey(key: string): boolean {
  return (
    NAMED_SECRET_SETTING_KEYS.includes(key) ||
    SECRET_KEY_SUFFIXES.some((suffix) => key.endsWith(suffix))
  );
}

// ----------------------------------------------------------- the generated

/**
 * The keys the manager writes into every deployment's own env file from the
 * deployment's own fields, whatever the version's contract declares.
 */
export const PER_DEPLOYMENT_SETTING_KEYS: readonly string[] = [
  'SRT_PASSPHRASE',
  'STREAM_KEY',
];

/**
 * Whether the manager fills this key per deployment, so a value left empty
 * here is filled in rather than missing.
 */
export function isGeneratedSettingKey(
  key: string,
  requiredSecrets: readonly string[],
): boolean {
  return requiredSecrets.includes(key) || PER_DEPLOYMENT_SETTING_KEYS.includes(key);
}
