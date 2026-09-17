import { BEE_GATEWAY_SERVICE, BEE_UPLOADER_SERVICE } from './constants.js';
import { defaultServicesFor, type StampGatedProfile } from './stampGating.js';

/**
 * How much of a chain a Bee node runs with.
 *
 * `light` has the chain on: a chequebook deployed through an RPC endpoint, gas
 * in xDAI and postage in BZZ, which is what anything that uploads needs.
 * `ultra-light` has no chain at all, so it costs nothing to run and can only
 * retrieve, which is what a viewer's gateway does.
 */
export type NodeMode = 'light' | 'ultra-light';

export const LIGHT_NODE_MODE = 'light';
export const ULTRA_LIGHT_NODE_MODE = 'ultra-light';

/** Every mode, for a schema's choices and for a form's options. */
export const NODE_MODES: readonly NodeMode[] = [
  LIGHT_NODE_MODE,
  ULTRA_LIGHT_NODE_MODE,
];

/**
 * The mode the stack starts these services in when nothing names one.
 *
 * The stack writes the mode into its compose file per service, publisher nodes
 * with the chain on and the viewer gateway without, so a profile that stores no
 * mode has to read exactly as the deployment already behaves.
 */
export function shippedNodeMode(services: readonly string[]): NodeMode {
  return services.includes(BEE_UPLOADER_SERVICE)
    ? LIGHT_NODE_MODE
    : ULTRA_LIGHT_NODE_MODE;
}

export function effectiveNodeMode(profile: StampGatedProfile): NodeMode {
  return profile.node_mode ?? shippedNodeMode(defaultServicesFor(profile));
}

/**
 * Why this deployment's node cannot run in the mode it was given, or null.
 *
 * The one case is the expensive one: an ultra-light node has no chequebook, so
 * it can neither buy postage nor pay the peers that forward what it uploads. A
 * bee-uploader set to it starts, reports healthy, and lands nothing.
 */
export function nodeModeProblem(profile: StampGatedProfile): string | null {
  const services = defaultServicesFor(profile);
  if (
    services.includes(BEE_UPLOADER_SERVICE) &&
    effectiveNodeMode(profile) === ULTRA_LIGHT_NODE_MODE
  ) {
    return 'an ultra-light node cannot upload';
  }
  return null;
}

/**
 * A viewer's Bee gateway put on the chain.
 *
 * It is the one node the stack ships without an endpoint, so it is the one that
 * needs extra keys written for it when an operator asks for light. A deployment
 * that also runs a bee-uploader is not one: its node is the uploader, and the
 * endpoint it reads is that node's own.
 */
export function isLightGateway(
  services: readonly string[],
  mode: NodeMode,
): boolean {
  return (
    mode === LIGHT_NODE_MODE &&
    services.includes(BEE_GATEWAY_SERVICE) &&
    !services.includes(BEE_UPLOADER_SERVICE)
  );
}
