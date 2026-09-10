import { execFileSync } from 'node:child_process';

import { getErrorMessage } from '@streaming-infra-manager/common';

import { Logger } from '../domain/Logger.js';

const logger = Logger.getInstance();

/**
 * `ssh -G` reads config files off disk and answers immediately; the budget is
 * there for the pathological case (an unreadable mount, a ProxyCommand that
 * blocks), because this runs synchronously inside request handling.
 */
const SSH_LOOKUP_TIMEOUT_MS = 3_000;

/**
 * The ssh config the api container reads is a bind mount, so an operator can add
 * a Host block without restarting the manager. Long enough that a page load does
 * not fork ssh once per ladder rung, short enough that such an edit takes effect
 * on its own.
 */
const DEFAULT_TTL_MS = 60_000;

/**
 * Names that are never ssh aliases, so asking ssh about them only costs a fork.
 * `native` is swarm-hls-stream's sentinel for "runs outside compose on this
 * machine" (see `is_native` in deploy/scripts/_lib.sh), not a host at all.
 */
const NOT_ALIASES = new Set([
  '',
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  'native',
]);

/**
 * What may be handed to `ssh -G`. `profiles.host` is already validated by
 * HOST_RE, but this is an exec boundary and must not lean on that alone: the
 * leading-alphanumeric requirement is the part that matters, since ssh has no
 * `--` and a name like `-oProxyCommand=…` would otherwise arrive as an option.
 */
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface CacheEntry {
  host: string;
  expiresAt: number;
}

export interface NetworkHostResolverOptions {
  /** Runs `ssh -G <name>` and returns its stdout. Throws when ssh fails. */
  exec?: (name: string) => string;
  now?: () => number;
  ttlMs?: number;
}

function sshConfigDump(name: string): string {
  return execFileSync('ssh', ['-G', name], {
    timeout: SSH_LOOKUP_TIMEOUT_MS,
    encoding: 'utf8',
  });
}

/**
 * The `hostname` line out of an `ssh -G` dump — the address ssh would actually
 * dial for that Host block. ssh prints one lower-cased keyword per line and
 * always prints this one, defaulting it to the name it was asked about.
 */
function hostnameFrom(dump: string): string | null {
  for (const line of dump.split('\n')) {
    if (line.startsWith('hostname ')) {
      return line.slice('hostname '.length).trim() || null;
    }
  }
  return null;
}

/** The ssh account half of a deploy target addresses a login, never the node. */
function stripUserInfo(target: string): string {
  const trimmed = target.trim();
  const at = trimmed.lastIndexOf('@');
  return at === -1 ? trimmed : trimmed.slice(at + 1);
}

/**
 * Turns a deploy target into an address something can dial, with its own cache
 * and its own way of running ssh. Use {@link resolveNetworkHost} unless you are
 * a test that needs to control both.
 */
export function createNetworkHostResolver(
  options: NetworkHostResolverOptions = {},
): (target: string) => string {
  const exec = options.exec ?? sshConfigDump;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const cache = new Map<string, CacheEntry>();

  // Never throws: a deploy target that cannot be resolved is still the operator's
  // best guess at an address, and the reachability probes are what report on it.
  const lookUp = (name: string): string => {
    let dump: string;
    try {
      dump = exec(name);
    } catch (err) {
      logger.debug(
        `[deployHost] ssh -G ${name} failed, using the name as given: ${getErrorMessage(err)}`,
      );
      return name;
    }

    const resolved = hostnameFrom(dump);
    // ssh echoes an unknown name straight back, so equality means "no Host block
    // matched" rather than "resolves to itself".
    if (!resolved || resolved === name) {
      logger.debug(
        `[deployHost] no ssh Host block for ${name}, using the name as given`,
      );
      return name;
    }
    return resolved;
  };

  return (target: string): string => {
    const name = stripUserInfo(target);
    if (NOT_ALIASES.has(name)) return name;
    // A dot or a colon means the value already addresses something directly — an
    // IPv4 or IPv6 literal, or a name the resolver can answer for. Same rule
    // deploy.sh's host_from_target applies, so both halves of a deploy agree on
    // what counts as an alias.
    if (name.includes('.') || name.includes(':')) return name;
    if (!ALIAS_RE.test(name)) return name;

    const hit = cache.get(name);
    if (hit && hit.expiresAt > now()) return hit.host;

    const host = lookUp(name);
    cache.set(name, { host, expiresAt: now() + ttlMs });
    return host;
  };
}

const defaultResolver = createNetworkHostResolver();

/**
 * The network address behind a deploy target.
 *
 * `profiles.host` is a *deploy* target — "localhost", an ssh alias, or
 * `user@host` — and deploy.sh only ever hands it to `ssh`. The manager also
 * composes HTTP URLs from it (a rung's bee API, the address written into
 * BEE_PUBLISHERS, the links the UI shows), and for those an alias is not an
 * address: `http://vultr-eu-1:10055` resolves nowhere, so every probe times out
 * and the pasted value is unusable on the host that receives it.
 *
 * So the alias is resolved the same way deploy.sh resolves it, through the same
 * ssh config the api container mounts: userinfo is dropped, a literal or a dotted
 * name is taken as given, and a dotless name goes through `ssh -G`. Anything that
 * cannot be resolved comes back unchanged — no worse than before.
 */
export function resolveNetworkHost(target: string): string {
  return defaultResolver(target);
}
