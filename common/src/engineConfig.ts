/**
 * A config file of the deployment's own for its media engine, shared by the
 * manager, the editor and the offline mock.
 *
 * The file is the engine's whole config with the stack's placeholder tokens
 * kept in it. The stack fills those at container start, so the passphrase,
 * the ports and the webhook token never sit in the stored text, and the
 * settings drawer keeps working through them: it edits the values, the file
 * edits the structure.
 */
import { OME_SERVICE, SRS_SERVICE } from './constants.js';
import type { EngineName } from './engines.js';
import { engineSettingsFields } from './engineSettings.js';

/**
 * How large a file may be. SRS's fully annotated full.conf is under 100 KiB,
 * and the manager's request body limit is 256 KiB with JSON escaping on top.
 */
export const ENGINE_CONFIG_MAX_BYTES = 128 * 1024;

export interface EngineConfigReference {
  label: string;
  url: string;
}

/** Where every directive of each engine is documented, for the editor to link. */
export const ENGINE_CONFIG_REFERENCES: Record<EngineName, EngineConfigReference[]> = {
  [SRS_SERVICE]: [
    {
      label: 'SRS full.conf, every directive with a comment',
      url: 'https://github.com/ossrs/srs/blob/develop/trunk/conf/full.conf',
    },
  ],
  [OME_SERVICE]: [
    {
      label: 'OvenMediaEngine configuration guide',
      url: 'https://airensoft.gitbook.io/ovenmediaengine/configuration',
    },
  ],
};

/** What `GET /profiles/:name/engine-config` answers. */
export interface EngineConfigView {
  engine: EngineName;
  /** The deployment's stack version runs the engine on a file of its own when asked. */
  supported: boolean;
  /** Why not, in words the editor shows instead of itself, or null. */
  unsupportedReason: string | null;
  /** The stored file, or null while the template runs. */
  config: string | null;
  /** The version's own template, which the editor opens on when nothing is stored. */
  template: string;
  /** The tokens the version's entrypoint fills, in the order it names them. */
  placeholders: string[];
  /** Why the last apply was reverted, or null. */
  error: string | null;
  references: EngineConfigReference[];
}

/** A stack placeholder token: `HLS_FRAGMENT_PLACEHOLDER`. */
const PLACEHOLDER_RE = /\b[A-Z][A-Z0-9_]*_PLACEHOLDER\b/g;

/** Every placeholder token in a text, once each, in order of first appearance. */
export function placeholdersIn(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER_RE)) seen.add(match[0]);
  return [...seen];
}

/**
 * The tokens a file names that the version's entrypoint does not fill. A
 * token the stack leaves in place reaches the engine as it stands, and the
 * engine either refuses the file or runs with a literal nobody meant.
 */
export function unknownPlaceholders(
  config: string,
  filled: readonly string[],
): string[] {
  return placeholdersIn(config).filter((token) => !filled.includes(token));
}

/**
 * The settings whose placeholder a custom file no longer carries, by key.
 *
 * The drawer still lets those be edited, and the value still lands in the
 * container's environment, but nothing in the file reads it. Said in the
 * drawer rather than silently ignored.
 */
export function settingsNotInConfig(
  engine: EngineName,
  config: string,
): string[] {
  const present = new Set(placeholdersIn(config));
  return engineSettingsFields(engine)
    .filter((field) => field.placeholder && !present.has(field.placeholder))
    .map((field) => field.key);
}
