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
};
