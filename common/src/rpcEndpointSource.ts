import { isLightGateway, type NodeMode, shippedNodeMode } from './nodeMode.js';
import { rpcEndpointProblem } from './publishUrl.js';

/**
 * Where a node's chain endpoint comes from.
 *
 * `manager` is the endpoint this manager is configured with, which is the one
 * an operator running their own node wants every deployment on. `stack` is
 * whatever the deployment's stack version carries, a public RPC that throttles.
 * `custom` is an address stored on the deployment itself.
 */
export type RpcEndpointSource = 'manager' | 'stack' | 'custom';

export const MANAGER_RPC_ENDPOINT_SOURCE = 'manager';
export const STACK_RPC_ENDPOINT_SOURCE = 'stack';
export const CUSTOM_RPC_ENDPOINT_SOURCE = 'custom';

/** Every source, for a schema's choices and for a form's options. */
export const RPC_ENDPOINT_SOURCES: readonly RpcEndpointSource[] = [
  MANAGER_RPC_ENDPOINT_SOURCE,
  STACK_RPC_ENDPOINT_SOURCE,
  CUSTOM_RPC_ENDPOINT_SOURCE,
];

/**
 * What every existing deployment has always done, and the column's default: no
 * RPC_ENDPOINT line in the env file, so the stack's own value applies.
 */
export const DEFAULT_RPC_ENDPOINT_SOURCE: RpcEndpointSource =
  STACK_RPC_ENDPOINT_SOURCE;

export interface RpcEndpointChoice {
  source: RpcEndpointSource;
  /** The address typed in, which belongs to `custom` and to nothing else. */
  url?: string | null;
  managerHasEndpoint: boolean;
  /** The mode this deployment's node was given, or nothing for the shipped one. */
  nodeMode?: NodeMode | null;
  services: readonly string[];
}

/**
 * Why this endpoint choice cannot be stored, or null.
 *
 * One rule for the request schema and the wizard, because a refusal an operator
 * only meets at the API is one they meet with the form already filled in.
 */
export function rpcEndpointChoiceProblem({
  source,
  url,
  managerHasEndpoint,
  nodeMode,
  services,
}: RpcEndpointChoice): string | null {
  const address = url?.trim();

  if (source === CUSTOM_RPC_ENDPOINT_SOURCE) {
    if (!address) return 'a custom RPC endpoint needs an address';
    return rpcEndpointProblem(address);
  }
  if (address) return 'only a custom RPC endpoint carries an address of its own';

  if (source === MANAGER_RPC_ENDPOINT_SOURCE && !managerHasEndpoint) {
    return 'the manager has no RPC endpoint configured, choose the stack’s default or type one';
  }
  // The stack gives its gateway an empty endpoint, which is what makes that
  // node ultra-light. A light one taking that default would come up with no
  // chain at all, and nothing anywhere would say so.
  if (
    source === STACK_RPC_ENDPOINT_SOURCE &&
    isLightGateway(services, nodeMode ?? shippedNodeMode(services))
  ) {
    return 'a light gateway needs an endpoint: the manager’s or a custom one';
  }
  return null;
}

/** What `GET /config` says about the manager's own endpoint. */
export interface ConfiguredBeeRpcEndpoint {
  configured: boolean;
  /** The host and the port, never the path or the userinfo. */
  host: string | null;
}

/**
 * The manager's endpoint as a browser may see it.
 *
 * An endpoint's URL can carry an API key, in its userinfo or in its path, and
 * this answer reaches every signed-in page. The host is all a wizard needs to
 * show which endpoint it is offering, and it is the part that carries no
 * secret.
 */
export function configuredBeeRpcEndpoint(
  endpoint: string | null | undefined,
): ConfiguredBeeRpcEndpoint {
  const address = endpoint?.trim();
  if (!address) return { configured: false, host: null };
  try {
    return { configured: true, host: new URL(address).host };
  } catch {
    return { configured: true, host: null };
  }
}
