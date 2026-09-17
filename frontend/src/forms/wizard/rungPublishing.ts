import type { LadderRungState } from '@streaming-infra-manager/common';

const NODE_CHECKS_PASSED = 'Node checks passed.';

/**
 * What the manager's own probe found at the address this rung publishes on.
 *
 * The node checks beside this line are the node's own observations, and say
 * nothing about whether anything answers where a pool sends an uploader. The
 * manager probes that address itself, so a rung it reached and a rung it did
 * not reach are two different answers, and only a state nothing probed leaves
 * publishing unverified.
 */
export function rungPublishingSummary(rung: LadderRungState | null): string {
  switch (rung?.urlState) {
    case 'ok':
      return `${NODE_CHECKS_PASSED} Publishing address answers.`;
    case 'unreachable':
      return `${NODE_CHECKS_PASSED} Publishing address did not answer.`;
    default:
      return `${NODE_CHECKS_PASSED} Publishing is not verified.`;
  }
}

/** The address a probe actually answered about, for the line under the summary. */
export function probedRungUrl(rung: LadderRungState | null): string | null {
  if (!rung) return null;
  return rung.urlState === 'ok' || rung.urlState === 'unreachable'
    ? rung.url
    : null;
}
