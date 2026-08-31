/**
 * Whether the address a ladder hands out can actually be reached.
 *
 * `BEE_PUBLISHERS` carries one URL per rung, and that URL is the *only* thing an
 * off-host stream-uploader has to go on. It is built arithmetically — public host
 * plus `10005 + slot*10` — so it always *looks* like a URL, and until something
 * checks it, "the ladder is ready" means no more than "we were able to compose a
 * string".
 *
 * Two of the ways it goes wrong are provable without touching the network, which
 * matters because they are silent otherwise:
 *
 *  - **A loopback host.** `resolveServerHost()` falls back to `localhost` when
 *    PUBLIC_HOST is unset, and logs a warning nobody reads. The value assembles
 *    fine and cannot work anywhere but this machine.
 *  - **An ssh target used as a network address.** `profiles.host` holds a *deploy*
 *    target — the schema documents it as "localhost, an ssh alias, or user@host".
 *    A `user@host` target composes to `http://deploy@1.2.3.4:10055`, which is not
 *    a bee base URL, and whose stray `@` sits inside a format that already uses
 *    `@` to separate the rung from the URL.
 *
 * The third way — the address is well-formed but nothing is listening — needs a
 * probe, and is reported separately, because a manager that cannot reach a public
 * address is weaker evidence than a malformed one: NAT hairpinning alone explains
 * it.
 */

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
  /** Provably unusable — no probe needed, and no probe would change it. */
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
      return 'this rung’s address points at the manager’s own machine — set PUBLIC_HOST so the uploader gets a reachable one';
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

/** Why a URL is worth a second look although it does not block. */
export function publishUrlWarning(state: PublishUrlState): string | null {
  return state === 'unreachable'
    ? 'nothing answered at this rung’s address — either it is not reachable from outside this host, or the manager itself cannot loop back to it'
    : null;
}
