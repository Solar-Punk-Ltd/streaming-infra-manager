import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  type PortProtocol,
  DEFAULT_MAX_SLOT,
  type EngineConfigSupport,
  type EngineImages,
  type StackContract,
  type StackPortVar,
} from '@streaming-infra-manager/common';

/**
 * What the manager reads out of a version's checkout rather than assuming it.
 *
 * Everything here is read from files the stack already keeps exact, because the
 * deploy scripts themselves read them: the port table is what `_lib.sh` shifts
 * per slot, the slot ceiling is what `deploy.sh` refuses above, the required
 * secrets are the keys the samples declare, and the engine defaults are the
 * `${VAR:-default}` fallbacks the entrypoints apply. Two versions with
 * different tables can therefore run side by side without a second copy of any
 * of it living in the manager.
 *
 * Static reading proves the shape and not the behaviour, which is what the
 * Tested flag on a version is for.
 */

const PORT_VARS_OPEN = /^\s*(?:readonly\s+)?PORT_VARS=\(\s*$/;
const PORT_VARS_CLOSE = /^\s*\)\s*$/;

/** The number in `--portSlot=<N> (1-99)` in deploy.sh's usage text. */
const SLOT_CAP_RE = /--portSlot=<N>\s*\(1-(\d+)\)/;

const LIB_SCRIPT = join('deploy', 'scripts', '_lib.sh');
const DEPLOY_SCRIPT = join('deploy', 'scripts', 'deploy.sh');
const DEPLOY_COMPOSE = join('deploy', 'docker-compose.yml');

/**
 * The compose override a version ships when its engine can run on a config
 * file of the operator's own. `build_compose_files` in `_lib.sh` appends it
 * when the matching env key is set, so the file being there is the feature.
 */
const ENGINE_CONFIG_OVERRIDES: Record<keyof EngineConfigSupport, string> = {
  srs: join('deploy', 'docker-compose.srs-conf.yml'),
  ome: join('deploy', 'docker-compose.ome-conf.yml'),
};
const ROOT_ENV_SAMPLE = '.env.sample';
const SRS_ENV_SAMPLE = join('engines', 'srs', '.env.sample');

const SRS_API_PORT_VAR = 'SRS_HTTP_API_PORT';
const CHEQUEBOOK_FLOOR_KEY = 'CHEQUEBOOK_MIN_BZZ';

/**
 * A secret the containers refuse to start without, and the sample file whose
 * declaring it is how the manager knows this version wants one.
 */
const REQUIRED_SECRETS: readonly { key: string; sample: string }[] = [
  { key: 'API_AUTH_TOKEN', sample: ROOT_ENV_SAMPLE },
  { key: 'SRS_WEBHOOK_TOKEN', sample: SRS_ENV_SAMPLE },
];

/** Engine knobs worth showing, and the entrypoint that decides each default. */
const ENGINE_DEFAULTS: readonly { entrypoint: string; keys: string[] }[] = [
  {
    entrypoint: join('engines', 'srs', 'entrypoint.sh'),
    keys: ['HLS_FRAGMENT', 'HLS_WINDOW', 'SRT_LATENCY'],
  },
  {
    entrypoint: join('engines', 'ome', 'entrypoint.sh'),
    keys: ['HLS_SEGMENT_DURATION', 'HLS_SEGMENT_COUNT'],
  },
];

export function readStackContract(root: string): StackContract {
  const lib = readRequired(root, LIB_SCRIPT);
  const { ports, warnings } = parsePortVars(lib);
  if (ports.length === 0) {
    throw new Error(
      `${join(root, LIB_SCRIPT)} declares no PORT_VARS, so this checkout is not a streaming stack the manager can deploy.`,
    );
  }

  const rootEnvSample = readOptional(root, ROOT_ENV_SAMPLE);
  const chequebookMinBzz = declaredValue(rootEnvSample, CHEQUEBOOK_FLOOR_KEY);

  // A compose file that cannot be read leaves the tags shared: unknown must
  // not run concurrently. The port table's warnings are the port table's.
  const compose = readOptional(root, DEPLOY_COMPOSE);
  const sharedTags = compose === '' ? { shared: true, warning: null } : readSharedImageTags(compose);
  if (sharedTags.warning) warnings.push(sharedTags.warning);
  const mappings = readPortMappings(compose);
  const portsWithProtocol = ports.map((port) => ({ ...port, protocol: mappings.protocols.get(port.name) ?? 'tcp' }));

  return {
    ports: portsWithProtocol,
    maxSlot: parseMaxSlot(readOptional(root, DEPLOY_SCRIPT)),
    requiredSecrets: readRequiredSecrets(root),
    engineDefaults: readEngineDefaults(root),
    features: {
      srsApiPort: ports.some((port) => port.name === SRS_API_PORT_VAR),
      chequebookGate: chequebookMinBzz !== null,
      sharedImageTags: sharedTags.shared,
    },
    chequebookMinBzz,
    engineConfig: readEngineConfigSupport(root),
    engineImages: readEngineImages(compose),
    warnings,
    allocationProblem: allocationProblemOf(ports, mappings.problems),
  };
}

/** Why no slot can be allocated on this version, or null. The first problem is the one named. */
function allocationProblemOf(ports: PortTableEntry[], problems: string[]): string | null {
  if (ports.length === 0) return `${LIB_SCRIPT} has no port table the manager could read, so it cannot reserve this version's ports.`;
  return problems[0] ?? null;
}

// ------------------------------------------------------------- the sources

function readRequired(root: string, relative: string): string {
  const path = join(root, relative);
  if (!existsSync(path)) {
    throw new Error(
      `${path} is missing, so the manager cannot read this version's deploy contract. Check that the build finished.`,
    );
  }
  return readFileSync(path, 'utf8');
}

/** An absent file is not an error: not every version ships every engine. */
function readOptional(root: string, relative: string): string {
  const path = join(root, relative);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

// --------------------------------------------------------------- the ports

/** A port table entry before the compose file says which protocol it is published on. */
type PortTableEntry = Omit<StackPortVar, 'protocol'>;

/** What one PORT_VARS block held, including the lines it could not be read for. */
interface PortTable {
  ports: PortTableEntry[];
  warnings: string[];
}

/**
 * The `readonly PORT_VARS=(...)` block. Entries are `NAME:default` or
 * `NAME:default:slotbase`, the slot base being the last field either way, and
 * comments and blank lines are skipped.
 *
 * A line with content that is neither of those shapes is reported rather than
 * dropped. Dropping it shortens the port table by one, and a port the manager
 * does not know about is one it does not shift per slot, so two deployments of
 * the version would bind the same one and nothing would say why.
 */
function parsePortVars(lib: string): PortTable {
  const lines = lib.split('\n');
  const ports: PortTableEntry[] = [];
  const warnings: string[] = [];
  let inside = false;

  for (const [index, raw] of lines.entries()) {
    if (!inside) {
      inside = PORT_VARS_OPEN.test(raw);
      continue;
    }
    if (PORT_VARS_CLOSE.test(raw)) break;

    const content = contentOf(raw);
    if (content === '') continue;

    const port = parsePortVarEntry(content);
    if (port) {
      ports.push(port);
    } else {
      warnings.push(
        `${LIB_SCRIPT} line ${index + 1} is not NAME:default or NAME:default:slotbase: ${content}`,
      );
    }
  }

  return { ports, warnings };
}

/** A line with its trailing comment and surrounding quotes taken off. */
function contentOf(raw: string): string {
  return raw.split('#')[0]?.trim().replace(/^["']|["']$/g, '') ?? '';
}

function parsePortVarEntry(line: string): PortTableEntry | null {
  const fields = line.split(':');
  const name = fields[0];
  const defaultPort = Number(fields[1]);
  const slotBase = Number(fields[fields.length - 1]);
  if (!name || !Number.isInteger(defaultPort) || !Number.isInteger(slotBase)) {
    return null;
  }

  return { name, defaultPort, slotBase };
}

// ---------------------------------------------------------------- the slot

function parseMaxSlot(deployScript: string): number {
  const cap = Number(SLOT_CAP_RE.exec(deployScript)?.[1]);
  return Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_MAX_SLOT;
}

// ------------------------------------------------------------- the secrets

function readRequiredSecrets(root: string): string[] {
  return REQUIRED_SECRETS.filter(({ key, sample }) =>
    declares(readOptional(root, sample), key),
  ).map(({ key }) => key);
}

/**
 * An env sample declares a key when it names it outside a comment, with or
 * without a value. Both branches keep these samples exact, which is what makes
 * presence a usable signal.
 */
function declares(sample: string, key: string): boolean {
  return declarationLine(sample, key) !== null;
}

function declarationLine(sample: string, key: string): string | null {
  for (const raw of sample.split('\n')) {
    const line = raw.trim();
    if (line.startsWith(`${key}=`)) return line;
  }
  return null;
}

/** The value a sample declares for a key, or null when it declares none. */
function declaredValue(sample: string, key: string): string | null {
  const line = declarationLine(sample, key);
  if (line === null) return null;

  const value = line.slice(key.length + 1).trim();
  return value === '' ? null : value;
}

// ------------------------------------------------------------ the mappings

const PORTS_KEY = /^    ports:\s*$/;
const FOUR_SPACE_KEY = /^    [a-z_]+:/;
const SHORT_ENTRY = /^      - (?:"([^"]*)"|'([^']*)'|(\S+))\s*$/;
const LONG_ENTRY_START = /^      - target:/;
const LONG_PUBLISHED = /^        published:\s*(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/;
const LONG_PROTOCOL = /^        protocol:\s*['"]?(tcp|udp)['"]?\s*$/;
const PUBLISHED_VAR = /^\$\{([A-Z][A-Z0-9_]*)(?::-[^}]*)?\}$/;

interface PortMappings {
  /** Port variable name to the protocol its mapping names. */
  protocols: Map<string, PortProtocol>;
  /** Mappings the reader could not follow, one message each, naming the line. */
  problems: string[];
}

/**
 * The protocol each port variable is published with, from the `ports:` of
 * every service in the compose file. Both forms Docker documents are read:
 * the short string, `[bind:]published:container[/protocol]`, where any part
 * may be a `${VAR:-default}` reference, and the long map with `target`,
 * `published` and `protocol` keys. A mapping the reader cannot follow, and a
 * published port no variable shifts, are problems: every deployment of the
 * version would bind the same port, or one the manager never reserved.
 */
function readPortMappings(compose: string): PortMappings {
  const protocols = new Map<string, PortProtocol>();
  const problems: string[] = [];
  let inPorts = false;
  let long: { published: string | null; protocol: PortProtocol; line: number } | null = null;

  const closeLong = (): void => {
    if (!long) return;
    record(long.published, long.protocol, long.line);
    long = null;
  };
  const record = (published: string | null, protocol: PortProtocol, line: number): void => {
    const name = published === null ? null : PUBLISHED_VAR.exec(published)?.[1] ?? null;
    if (name) {
      protocols.set(name, protocol);
      return;
    }
    problems.push(
      `${DEPLOY_COMPOSE} line ${line} publishes ${published ?? 'no port'}, which no port variable shifts per slot, so every deployment would bind it.`,
    );
  };

  const lines = compose.split('\n');
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (PORTS_KEY.test(line)) {
      closeLong();
      inPorts = true;
      continue;
    }
    if (!inPorts) continue;
    if (SERVICE_LINE.test(line) || FOUR_SPACE_KEY.test(line)) {
      closeLong();
      inPorts = false;
      continue;
    }
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (LONG_ENTRY_START.test(line)) {
      closeLong();
      long = { published: null, protocol: 'tcp', line: lineNumber };
      continue;
    }
    if (long) {
      const published = LONG_PUBLISHED.exec(line);
      if (published) {
        long.published = published[1] ?? published[2] ?? published[3] ?? null;
        continue;
      }
      const protocol = LONG_PROTOCOL.exec(line);
      if (protocol) long.protocol = protocol[1] as PortProtocol;
      continue;
    }
    const short = SHORT_ENTRY.exec(line);
    const entry = short ? (short[1] ?? short[2] ?? short[3] ?? '') : null;
    const parsed = entry === null ? null : parseShortMapping(entry);
    if (!parsed) {
      problems.push(`${DEPLOY_COMPOSE} line ${lineNumber} is a port mapping the manager cannot read: ${line.trim()}`);
      continue;
    }
    record(parsed.published, parsed.protocol, lineNumber);
  }
  closeLong();
  return { protocols, problems };
}

/** `[bind:]published:container[/protocol]`, split on the colons outside `${...}`. */
function parseShortMapping(entry: string): { published: string; protocol: PortProtocol } | null {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of entry) {
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (char === ':' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => part === '')) return null;
  const published = parts[parts.length - 2]!;
  const container = parts[parts.length - 1]!;
  const slash = container.indexOf('/');
  const protocol = slash === -1 ? 'tcp' : container.slice(slash + 1);
  if (protocol !== 'tcp' && protocol !== 'udp') return null;
  return { published, protocol };
}

// ------------------------------------------------------------- the engines

function readEngineConfigSupport(root: string): EngineConfigSupport {
  return {
    srs: existsSync(join(root, ENGINE_CONFIG_OVERRIDES.srs)),
    ome: existsSync(join(root, ENGINE_CONFIG_OVERRIDES.ome)),
  };
}

const SERVICE_LINE = /^  ([a-z][a-z0-9-]*):\s*$/;
const IMAGE_LINE = /^    image:\s*['"]?([^'"\s]+)['"]?\s*$/;
const IMAGE_KEY = /^    image:/;
const BUILD_LINE = /^    build:/;

const COMPOSE_NOT_READ = `${DEPLOY_COMPOSE}: no service could be read from it (a service is a two-space indented name under services:), so the version is treated as sharing image tags.`;

interface SharedImageTags {
  shared: boolean;
  warning: string | null;
}

/**
 * Whether a built service names its image. Compose tags a build by that
 * name, one tag for every project that builds the service, so two
 * deployments building at once race on it. Without the name compose tags
 * the build `<project>-<service>`, one per deployment.
 *
 * Unknown must not run concurrently: a file whose services this reader
 * cannot follow counts as shared, and says so, and an image key names the
 * build whatever its value looks like.
 */
function readSharedImageTags(compose: string): SharedImageTags {
  const built = new Set<string>();
  const named = new Set<string>();
  let service: string | null = null;
  let services = 0;
  for (const line of compose.split('\n')) {
    const serviceMatch = SERVICE_LINE.exec(line);
    if (serviceMatch) {
      service = serviceMatch[1]!;
      services += 1;
      continue;
    }
    if (service === null) continue;
    if (BUILD_LINE.test(line)) built.add(service);
    if (IMAGE_KEY.test(line)) named.add(service);
  }
  if (services === 0) return { shared: true, warning: COMPOSE_NOT_READ };
  return { shared: [...built].some((name) => named.has(name)), warning: null };
}

/**
 * The `image:` of the `srs` and `ome` services in the deploy compose file.
 *
 * A line scan rather than a YAML parser, and enough for it: a service is a
 * two-space indented name under `services:` and its image is the four-space
 * indented `image:` line inside it. The whole file is what `docker compose
 * config` would need, and this only wants two strings out of it.
 */
function readEngineImages(compose: string): EngineImages {
  const images: EngineImages = { srs: null, ome: null };
  let service: string | null = null;

  for (const line of compose.split('\n')) {
    const serviceMatch = SERVICE_LINE.exec(line);
    if (serviceMatch) {
      service = serviceMatch[1]!;
      continue;
    }
    const imageMatch = IMAGE_LINE.exec(line);
    if (!imageMatch) continue;
    if (service === 'srs' && images.srs === null) images.srs = imageMatch[1]!;
    if (service === 'ome' && images.ome === null) images.ome = imageMatch[1]!;
  }

  return images;
}

function readEngineDefaults(root: string): Record<string, string> {
  const defaults: Record<string, string> = {};

  for (const { entrypoint, keys } of ENGINE_DEFAULTS) {
    const text = readOptional(root, entrypoint);
    if (!text) continue;

    for (const key of keys) {
      const fallback = fallbackFor(text, key);
      if (fallback !== null) defaults[key] = fallback;
    }
  }

  return defaults;
}

/**
 * The `default` in the entrypoint's first `${KEY:-default}`.
 *
 * A default that is itself a substitution, `${HLS_FRAGMENT:-${FRAGMENT:-1.5}}`,
 * is not supported: the match ends at the first closing brace, which is the
 * inner one, so the value would come back as `${FRAGMENT:-1.5` and the engine
 * settings drawer would offer that as a number to an operator. Null says the
 * manager does not know this default, which is true.
 */
function fallbackFor(entrypoint: string, key: string): string | null {
  const pattern = new RegExp(`\\$\\{${key}:-([^}]*)\\}`);
  const value = pattern.exec(entrypoint)?.[1]?.trim();
  if (!value || value.includes('${')) return null;
  return value;
}
