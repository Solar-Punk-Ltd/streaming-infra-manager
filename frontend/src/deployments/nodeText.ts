import {
  CUSTOM_RPC_ENDPOINT_SOURCE,
  LIGHT_NODE_MODE,
  MANAGER_RPC_ENDPOINT_SOURCE,
  type NodeMode,
  type RpcEndpointSource,
  ULTRA_LIGHT_NODE_MODE,
} from '@streaming-infra-manager/common';

/**
 * The two lines a deployment's Bee node is described by: how much of a chain
 * it runs with, and where it reaches that chain.
 *
 * One set of words for the deployment page and for the wizard's review, so
 * what an operator reads before creating a node and what they read on its page
 * afterwards cannot say different things about the same choice.
 */
const NODE_MODE_LABELS: Record<NodeMode, string> = {
  [LIGHT_NODE_MODE]: 'Light, publishes',
  [ULTRA_LIGHT_NODE_MODE]: 'Ultra-light, download only',
};

export function nodeModeLabel(mode: NodeMode): string {
  return NODE_MODE_LABELS[mode];
}

export interface RpcEndpointLine {
  mode: NodeMode;
  source: RpcEndpointSource;
  /**
   * The host that source resolves to, and never the URL. An endpoint can carry
   * an API key in its path or its user info, so only the host is ever shown.
   */
  host: string | null;
}

export function rpcEndpointLabel({ mode, source, host }: RpcEndpointLine): string {
  // Naming a source here would name the very setting that makes this node
  // ultra-light, an empty endpoint, as though it were one the node reads.
  if (mode === ULTRA_LIGHT_NODE_MODE) return 'None, an ultra-light node reaches no chain';
  const named = (name: string) => (host ? `${name} (${host})` : name);
  if (source === MANAGER_RPC_ENDPOINT_SOURCE) return named("Manager's endpoint");
  if (source === CUSTOM_RPC_ENDPOINT_SOURCE) return named('Custom');
  return 'Stack default, public';
}
