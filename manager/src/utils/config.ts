import 'dotenv/config';

import {
  bzzToPlur,
  DEFAULT_CHEQUEBOOK_FLOOR_BZZ,
  rpcEndpointProblem,
} from '@streaming-infra-manager/common';

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value : fallback;
}

/**
 * How little a bee node may have in its chequebook before the manager warns
 * when starting an uploader against it, read once at startup.
 *
 * A bad value stops the process rather than falling back to the default: the
 * whole point of the setting is that one number is quoted in that warning and
 * shown in the UI, and quietly using a different one than the operator wrote is
 * worse than not starting.
 */
function chequebookFloorPlur(): bigint {
  const raw = optional('CHEQUEBOOK_FLOOR_BZZ', DEFAULT_CHEQUEBOOK_FLOOR_BZZ);
  const plur = bzzToPlur(raw);
  if (plur === null) {
    throw new Error(
      `CHEQUEBOOK_FLOOR_BZZ must be a BZZ amount above zero with at most 16 decimal places, got: ${raw}`,
    );
  }
  return plur;
}

/**
 * The chain endpoint this manager offers every Bee node created from the
 * wizard, or null when the operator configured none.
 *
 * A malformed value stops the process rather than being dropped, for the reason
 * the chequebook floor does: a deployment created against a dropped endpoint
 * falls back to the stack's own, a public RPC that answered one node 4568 HTTP
 * 429s in two hours, and nothing anywhere would say it had.
 *
 * Such a URL can carry an API key in its path, so only its host is logged,
 * answered to a browser, or left in the container logs and the deploy output
 * the manager passes on. The node's own container log on the host carries the
 * whole address whatever this does, which is why manager/.env.sample asks for
 * an address that carries no key.
 *
 * Exported so the refusal can be tested without the process exiting.
 */
export function beeRpcEndpoint(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const problem = rpcEndpointProblem(value);
  if (problem) throw new Error(`BEE_RPC_ENDPOINT: ${problem}`);
  return value;
}

/** The public admin-console base, or null when this manager does not name one. */
export function streamAdminConsoleUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('STREAM_ADMIN_CONSOLE_URL must be an HTTP or HTTPS URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('STREAM_ADMIN_CONSOLE_URL must be an HTTP or HTTPS base URL without credentials, query, or fragment');
  }
  return url.href.replace(/\/$/, '');
}

const MANAGED_SRS_TOKEN = /^[\x21-\x7e]{32,8192}$/;

export interface ManagedSrsLifecycleConfig {
  lifecycleVersion: 1;
  adminApiUrl: string;
  adminApiToken: string;
}

/** The manager-side settings that enable lifecycle reporting in capable SRS stacks. */
export function managedSrsLifecycleConfig(
  env: Readonly<Record<string, string | undefined>>,
): ManagedSrsLifecycleConfig | null {
  const version = env.SRS_LIFECYCLE_VERSION?.trim() ?? '';
  const adminApiUrl = env.ADMIN_API_URL?.trim() ?? '';
  const adminApiToken = env.ADMIN_API_TOKEN ?? '';
  if (!version && !adminApiUrl && !adminApiToken) return null;
  if (version !== '1') {
    throw new Error(
      'SRS_LIFECYCLE_VERSION must be 1 when managed SRS lifecycle is configured',
    );
  }
  if (!adminApiUrl) {
    throw new Error('ADMIN_API_URL is required for managed SRS lifecycle');
  }
  if (!MANAGED_SRS_TOKEN.test(adminApiToken)) {
    throw new Error('ADMIN_API_TOKEN is invalid for managed SRS lifecycle');
  }
  let url: URL;
  try {
    url = new URL(adminApiUrl);
  } catch {
    throw new Error('ADMIN_API_URL must be an HTTP or HTTPS base URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'ADMIN_API_URL must be an HTTP or HTTPS base URL without credentials, query, or fragment',
    );
  }
  return {
    lifecycleVersion: 1,
    adminApiUrl: url.href.replace(/\/$/, ''),
    adminApiToken,
  };
}

export interface AppConfig {
  port: number;
  host: string;
  publicHost: string;
  databaseUrl: string;
  logLevel: string;
  chequebookFloorPlur: bigint;
  /**
   * Where added stack versions are checked out. A sibling of the data root,
   * outside the tree `deploy/deploy.sh` rsyncs with --delete, and bind-mounted
   * into the api container at this same absolute path.
   */
  stackVersionsRoot: string;
  /** See `beeRpcEndpoint`. Null when the operator configured none. */
  beeRpcEndpoint: string | null;
  streamAdminConsoleUrl: string | null;
  managedSrsLifecycle: ManagedSrsLifecycleConfig | null;
}

export const config: AppConfig = {
  port: Number(optional('MANAGER_PORT', '9876')),
  host: optional('MANAGER_HOST', '0.0.0.0'),
  publicHost: optional('PUBLIC_HOST', ''),
  databaseUrl: required('DATABASE_URL'),
  logLevel: optional('LOG_LEVEL', 'info'),
  chequebookFloorPlur: chequebookFloorPlur(),
  stackVersionsRoot: optional(
    'STACK_VERSIONS_ROOT',
    '/home/solarpunk/streaming-infra-manager-versions',
  ),
  beeRpcEndpoint: beeRpcEndpoint(process.env.BEE_RPC_ENDPOINT),
  streamAdminConsoleUrl: streamAdminConsoleUrl(process.env.STREAM_ADMIN_CONSOLE_URL),
  managedSrsLifecycle: managedSrsLifecycleConfig(process.env),
};
