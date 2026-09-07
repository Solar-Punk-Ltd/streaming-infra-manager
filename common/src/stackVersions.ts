/**
 * What a version of the streaming stack is, shared by the manager, the frontend
 * and the offline mock.
 *
 * A version is a git ref pinned to a commit, checked out once and built once.
 * Its contract is the part of that checkout the manager has to know rather than
 * assume: which ports the deploy scripts shift, how high a port slot may go,
 * which secrets the containers refuse to start without, and what the engines
 * default to. Reading it from the checkout is what lets two versions with
 * different port tables run side by side.
 *
 * The rules below are here rather than in the manager because all three sides
 * apply them: the form refuses a bad branch name before it is sent, the manager
 * refuses it again before it spawns anything, and the mock has to refuse it the
 * same way for the offline flow to be worth playing.
 */

/** The version the manager ships with, always present and never removable. */
export const BUNDLED_VERSION_NAME = 'bundled';

export type StackVersionStatus = 'building' | 'ready' | 'failed';

export const STACK_VERSION_STATUSES: readonly StackVersionStatus[] = [
  'building',
  'ready',
  'failed',
];

/** One entry of a version's PORT_VARS table in `deploy/scripts/_lib.sh`. */
export interface StackPortVar {
  name: string;
  /** The port used when no port slot is given. */
  defaultPort: number;
  /** A slot shifts this by ten per slot: `slotBase + slot * 10`. */
  slotBase: number;
}

export interface StackContractFeatures {
  /** SRS publishes its read-only stats API, so live engine status can be read. */
  srsApiPort: boolean;
  /** The uploader refuses to start on a Bee node whose chequebook is too low. */
  chequebookGate: boolean;
  /**
   * A built service declares an `image:` name, so every deployment's build
   * of it moves one shared tag. True as well when the compose file could not
   * be read, because unknown must not run concurrently.
   */
  sharedImageTags: boolean;
}

/** Per engine: whether the version runs it on a config file of the operator's own when asked. */
export interface EngineConfigSupport {
  srs: boolean;
  ome: boolean;
}

/** Per engine: the image its compose service runs, or null when the version has no such service. */
export interface EngineImages {
  srs: string | null;
  ome: string | null;
}

/** What the manager reads out of a version's checkout instead of assuming it. */
export interface StackContract {
  ports: StackPortVar[];
  /** The highest port slot `deploy.sh` accepts. */
  maxSlot: number;
  /** Env keys the containers refuse to start without, generated per deployment. */
  requiredSecrets: string[];
  /** Engine knobs and the value each falls back to, from the entrypoints. */
  engineDefaults: Record<string, string>;
  features: StackContractFeatures;
  /** The chequebook floor in BZZ when `features.chequebookGate`, else null. */
  chequebookMinBzz: string | null;
  /**
   * Which engines can run on a config file of the operator's own: the version
   * ships the compose override that mounts one. Read at build time, so an
   * editor knows before it opens whether the file it saves would be applied.
   */
  engineConfig: EngineConfigSupport;
  /** What each engine service runs, so a config can be checked with the same image. */
  engineImages: EngineImages;
  /**
   * The lines of the version's files the reader could not make sense of, one
   * message each, naming the file. A port the manager did not read is a port
   * it will not shift per slot, so two deployments of this version would bind
   * the same one, and a silently shorter table looks exactly like a version
   * that has fewer ports. A compose file it could not follow is treated as
   * sharing image tags, and the message says so.
   */
  warnings: string[];
}

/** One row of the Versions page, as `GET /versions` answers it. */
export interface StackVersion {
  id: number;
  name: string;
  /** The branch or tag this version follows. */
  gitRef: string;
  /** The commit it is pinned to, or null when the host cannot tell. */
  commitSha: string | null;
  status: StackVersionStatus;
  isDefault: boolean;
  /** Set by hand after one real deployment has run on this version. */
  tested: boolean;
  /** ISO, or null for a version that has never finished a build. */
  builtAt: string | null;
  /** Why the last build failed, or null. */
  lastError: string | null;
  /** Null while a version is still building for the first time. */
  contract: StackContract | null;
  /** How many deployments run this version. */
  deployments: number;
  /** Where the version deploys from: its flat root, as before builds, or its current build. */
  layout: 'legacy' | 'builds';
  /** The current build of a builds row, the commit or `<commit>-r<n>`, or null. */
  buildId: string | null;
  /** The build the current one replaced, kept for recovery, or null. */
  previousBuildId: string | null;
}

/** Slot ceiling for a version whose deploy script names no other. */
export const DEFAULT_MAX_SLOT = 999;

// --------------------------------------------------------------- the names

export const STACK_VERSION_NAME_MAX = 40;
export const STACK_VERSION_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Why a version name is refused, in words the operator can act on, or null.
 * The same rule as the CHECK constraint in migration 010.
 */
export function stackVersionNameProblem(name: string): string | null {
  if (!name) {
    return 'Type a name for this version, for example main-v3.';
  }
  if (name.length > STACK_VERSION_NAME_MAX) {
    return `A version name can be at most ${STACK_VERSION_NAME_MAX} characters.`;
  }
  if (!STACK_VERSION_NAME_RE.test(name)) {
    return 'A version name may hold lower case letters, digits and dashes, and must start with a letter or a digit.';
  }
  return null;
}

// ----------------------------------------------------------------- the ref

export const STACK_REF_MAX = 100;
const STACK_REF_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * Why a branch or tag is refused, or null.
 *
 * This runs before the manager spawns the build script, which passes the value
 * to `git clone --branch`. A leading dash would read as an option there, and
 * `..` is how a path escapes the directory it was given.
 */
export function stackRefProblem(ref: string): string | null {
  if (!ref) {
    return 'Type a branch or a tag, for example main-v3.';
  }
  if (ref.length > STACK_REF_MAX) {
    return `A branch or tag can be at most ${STACK_REF_MAX} characters.`;
  }
  if (!STACK_REF_RE.test(ref)) {
    return 'A branch or tag may hold letters, digits, dot, underscore, slash and dash, and nothing else.';
  }
  if (ref.startsWith('-')) {
    return 'A branch or tag cannot start with a dash.';
  }
  if (ref.includes('..')) {
    return 'A branch or tag cannot hold two dots in a row.';
  }
  return null;
}

/**
 * The name a branch or tag suggests: lower case, with everything that is not a
 * letter or a digit folded into single dashes. `feature/Fast_HLS` becomes
 * `feature-fast-hls`. Empty when nothing usable is left, so the caller asks.
 */
export function versionNameFromRef(ref: string): string {
  return ref
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, STACK_VERSION_NAME_MAX)
    .replace(/-+$/, '');
}

// ------------------------------------------------------------ the contract

/**
 * The contract in one line of plain words, for the Versions page.
 *
 * `10 ports, slots 1 to 99, needs 2 generated secrets, SRS API published,
 * chequebook gate 0.5 BZZ`
 */
export function describeStackContract(contract: StackContract): string {
  const parts = [
    `${contract.ports.length} ports`,
    `slots 1 to ${contract.maxSlot}`,
    describeSecrets(contract.requiredSecrets.length),
  ];
  if (contract.features.srsApiPort) {
    parts.push('SRS API published');
  }
  if (contract.features.chequebookGate && contract.chequebookMinBzz) {
    parts.push(`chequebook gate ${contract.chequebookMinBzz} BZZ`);
  }
  const editable = describeEngineConfig(contract.engineConfig);
  if (editable) parts.push(editable);
  if (contract.warnings.length > 0) {
    const count = contract.warnings.length;
    parts.push(`${count} ${count === 1 ? 'line' : 'lines'} not understood`);
  }
  return parts.join(', ');
}

function describeEngineConfig(support: EngineConfigSupport): string | null {
  if (support.srs && support.ome) return 'own config file for both engines';
  if (support.srs) return 'own config file for SRS';
  if (support.ome) return 'own config file for OvenMediaEngine';
  return null;
}

function describeSecrets(count: number): string {
  if (count === 0) return 'no generated secrets';
  if (count === 1) return 'needs 1 generated secret';
  return `needs ${count} generated secrets`;
}

// ------------------------------------------------------------- the parsing

/**
 * A stored contract read back as one, or null when the column still holds the
 * empty object a version starts with.
 *
 * Checked field by field rather than trusted: the value comes back out of a
 * JSONB column, so the compiler has never seen it, and a version built by an
 * older manager may hold a shape this one does not know.
 */
export function parseStackContract(value: unknown): StackContract | null {
  if (!isRecord(value)) return null;

  const ports = parsePorts(value.ports);
  const maxSlot = value.maxSlot;
  const features = value.features;
  if (ports === null || typeof maxSlot !== 'number' || !isRecord(features)) {
    return null;
  }

  return {
    ports,
    maxSlot,
    requiredSecrets: stringsOf(value.requiredSecrets),
    engineDefaults: stringMapOf(value.engineDefaults),
    features: {
      srsApiPort: features.srsApiPort === true,
      chequebookGate: features.chequebookGate === true,
      // Absent from a contract an older manager stored, which was never
      // classified, and unknown must not run concurrently.
      sharedImageTags: features.sharedImageTags !== false,
    },
    chequebookMinBzz:
      typeof value.chequebookMinBzz === 'string' ? value.chequebookMinBzz : null,
    // Absent from a contract read by an older manager, which is a version
    // that was never asked and so is not known to support it.
    engineConfig: engineConfigOf(value.engineConfig),
    engineImages: engineImagesOf(value.engineImages),
    warnings: stringsOf(value.warnings),
  };
}

function engineConfigOf(value: unknown): EngineConfigSupport {
  const record = isRecord(value) ? value : {};
  return { srs: record.srs === true, ome: record.ome === true };
}

function engineImagesOf(value: unknown): EngineImages {
  const record = isRecord(value) ? value : {};
  return {
    srs: typeof record.srs === 'string' ? record.srs : null,
    ome: typeof record.ome === 'string' ? record.ome : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePorts(value: unknown): StackPortVar[] | null {
  if (!Array.isArray(value)) return null;

  const ports: StackPortVar[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.name !== 'string' ||
      typeof entry.defaultPort !== 'number' ||
      typeof entry.slotBase !== 'number'
    ) {
      return null;
    }
    ports.push({
      name: entry.name,
      defaultPort: entry.defaultPort,
      slotBase: entry.slotBase,
    });
  }
  return ports;
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function stringMapOf(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};

  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}
