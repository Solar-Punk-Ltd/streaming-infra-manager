import { TargetNotVerifiedError } from '../errors/index.js';

/**
 * Which daemon a deployment's host name reaches. A reservation is keyed by
 * the daemon's identity, from `docker info`, never by the spelling of a
 * target, so two aliases of one daemon share one namespace and an alias
 * whose daemon cannot be established opens none.
 */
export interface DeployTargets {
  /** The daemon id the alias reaches. Throws `TargetNotVerifiedError` for one that is not verified. */
  daemonIdFor(host: string | null): Promise<string>;
}

/** The names a deployment uses for the daemon the manager itself runs against. */
export const LOCAL_TARGET_ALIASES: readonly string[] = ['localhost'];

export function targetAlias(host: string | null): string {
  const alias = host || 'localhost';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,127}$/.test(alias)) {
    throw new TargetNotVerifiedError(alias);
  }
  return alias;
}

export function isLocalTarget(host: string | null): boolean {
  return host === null || host === '' || LOCAL_TARGET_ALIASES.includes(host);
}

/**
 * The local daemon only: every other alias is unverified until the target
 * table verifies it over ssh, which is what the next slice adds.
 */
export class LocalOnlyTargets implements DeployTargets {
  constructor(private readonly daemon: { daemonId(): Promise<string> }) {}

  async daemonIdFor(host: string | null): Promise<string> {
    if (isLocalTarget(host)) return this.daemon.daemonId();
    throw new TargetNotVerifiedError(host ?? '');
  }
}
