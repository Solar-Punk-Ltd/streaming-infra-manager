import {
  isLightGateway,
  type NodeMode,
  shippedNodeMode,
  ULTRA_LIGHT_NODE_MODE,
} from './nodeMode.js';
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

/** What a node is, as far as an endpoint choice is concerned. */
export interface RpcEndpointNode {
  /** The address the body carries, if any. */
  url?: string | null;
  managerHasEndpoint: boolean;
  /** The mode the node was given, or nothing for the shipped one. */
  nodeMode?: NodeMode | null;
  services: readonly string[];
}

/**
 * The source a create means when it names none.
 *
 * An address and nothing else is what `POST /profiles` took before a source
 * existed, and what migration 035 reads such a row as, so it means the same
 * thing here. Otherwise the manager's own endpoint is offered first, which is
 * the whole point of configuring one.
 *
 * Except to a node that runs no chain. An ultra-light node reads no endpoint at
 * all, and the wizard sends no source for one, so offering it the manager's
 * would write a keyed URL into an env file that travels to the viewer's host
 * for a node that never reads it, tell the page it takes the manager's
 * endpoint, and refuse its next deploy the day the manager loses an endpoint it
 * never needed.
 */
export function impliedRpcEndpointSource({
  url,
  managerHasEndpoint,
  nodeMode,
  services,
}: RpcEndpointNode): RpcEndpointSource {
  if (url?.trim()) return CUSTOM_RPC_ENDPOINT_SOURCE;
  const mode = nodeMode ?? shippedNodeMode(services);
  if (mode === ULTRA_LIGHT_NODE_MODE) return DEFAULT_RPC_ENDPOINT_SOURCE;
  return managerHasEndpoint
    ? MANAGER_RPC_ENDPOINT_SOURCE
    : DEFAULT_RPC_ENDPOINT_SOURCE;
}

/**
 * The source an update means when it names none.
 *
 * A stored choice survives an edit about something else, so a deployment on the
 * manager's endpoint is never moved onto the stack's public one by a saved
 * note. The address is the exception both ways: it and `custom` travel
 * together, so an address arriving means custom and an address going takes the
 * custom choice with it.
 *
 * Where it goes then is the same question a create answers: emptying the box in
 * the drawer asks for this node's endpoint to stop being that one, and it is
 * not a request for the public RPC. So the node lands on the manager's endpoint
 * where there is one to land on, and on the stack's only when there is nothing
 * else for a node of its kind.
 */
export function keptRpcEndpointSource({
  url,
  stored,
  managerHasEndpoint,
  nodeMode,
  services,
}: RpcEndpointNode & { stored: RpcEndpointSource }): RpcEndpointSource {
  if (url?.trim()) return CUSTOM_RPC_ENDPOINT_SOURCE;
  if (stored !== CUSTOM_RPC_ENDPOINT_SOURCE) return stored;
  return impliedRpcEndpointSource({
    url: null,
    managerHasEndpoint,
    nodeMode,
    services,
  });
}

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
 * An endpoint's URL can carry an API key in its path, and this answer reaches
 * every signed-in page. The host is all a wizard needs to show which endpoint
 * it is offering, and it is the part that carries no secret. It is not nothing
 * either: a provider that issues an account its own subdomain is named by the
 * host alone.
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
